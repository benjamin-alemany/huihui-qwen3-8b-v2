"""Portable failure gates with dummy CUDA functions; never imports CUDA/torch."""
import contextlib
import ctypes as C
import importlib.util
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch, Mock

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('cuda_diagnostic', HERE / 'cuda_diagnostic.py')
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class Function:
    def __init__(self, code=0, value=None):
        self.code, self.value, self.called = code, value, False

    def __call__(self, argument):
        self.called = True
        if self.value is not None:
            C.cast(argument, C.POINTER(C.c_int))[0] = self.value
        return self.code


class DiagnosticTests(unittest.TestCase):
    def driver(self, code=0, count=1):
        driver = Mock()
        driver.cuDriverGetVersion = Function(value=13000)
        driver.cuInit = Function(code=code)
        driver.cuDeviceGetCount = Function(value=count)
        return driver

    def run_driver(self, driver):
        output = io.StringIO()
        load = Mock(return_value=driver)
        with contextlib.redirect_stdout(output):
            result = probe.driver_probe(load)
        events = [json.loads(line.split(' ', 1)[1]) for line in output.getvalue().splitlines()]
        load.assert_called_once_with('libcuda.so.1', mode=probe.os.RTLD_NOW | probe.os.RTLD_LOCAL)
        return result, events

    def test_cuda_304_stops_before_device_enumeration(self):
        driver = self.driver(304)
        passed, events = self.run_driver(driver)
        self.assertFalse(passed)
        self.assertFalse(driver.cuDeviceGetCount.called)
        self.assertEqual(events[-1], {'stage': 'cuInit_result', 'cuda_code': 304})

    def test_one_device_required_and_cuda_success_is_not_model_validation(self):
        for count in (0, 1, 2):
            passed, events = self.run_driver(self.driver(count=count))
            self.assertEqual(passed, count == 1)
            self.assertEqual(events[-1]['stage'], 'device_count')
        source = (HERE / 'cuda_diagnostic.py').read_text()
        for forbidden in ('import torch', 'import chat_server', 'import vllm', 'offline_cache', 'subprocess', 'os.exec'):
            self.assertNotIn(forbidden, source)

    def test_credential_refusal_precedes_network_and_cuda(self):
        with patch.object(sys, 'argv', ['diagnostic']), patch.object(probe.boundary, 'verify_child', side_effect=ValueError), \
             patch.object(probe.network_boundary, 'install') as network, patch.object(probe.C, 'CDLL') as load:
            with self.assertRaises(ValueError): probe.main()
            network.assert_not_called()
            load.assert_not_called()

    def test_network_failure_precedes_cuda_and_no_fallback(self):
        with patch.object(sys, 'argv', ['diagnostic']), patch.object(probe.boundary, 'verify_child', return_value={}), \
             patch.object(probe.network_boundary, 'install', side_effect=ValueError), \
             patch.object(probe.C, 'CDLL') as load, contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(ValueError): probe.main()
            load.assert_not_called()

    def test_missing_audit_library_refuses_before_driver(self):
        with patch.object(sys, 'argv', ['diagnostic']), patch.object(probe.boundary, 'verify_child', return_value={}), \
             patch.object(probe.network_boundary, 'install', return_value={}), \
             patch.object(probe.C, 'CDLL', return_value=object()), patch.object(probe, 'driver_probe') as driver, \
             contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(AttributeError): probe.main()
            driver.assert_not_called()

    def test_no_arbitrary_command_and_no_new_production_policy_path(self):
        with patch.object(sys, 'argv', ['diagnostic', '/bin/sh']), patch.object(probe.boundary, 'verify_child') as boundary:
            with self.assertRaises(ValueError): probe.main()
            boundary.assert_not_called()
        recipe = (HERE / 'Dockerfile.cuda-diagnostic').read_text()
        self.assertIn('cuda_diagnostic.py /opt/qwen/model_boot.py', recipe)
        self.assertNotIn('model-cache', recipe)
        self.assertNotIn('EXPOSE', recipe)


if __name__ == '__main__':
    unittest.main()
