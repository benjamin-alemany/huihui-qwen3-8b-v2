"""Adversarial HTTP tests with a dummy engine; no torch, model or cloud API."""
import copy
import http.client
from http.server import HTTPServer
import json
import os
from pathlib import Path
import socket
import sys
import threading
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parent))
import chat_server as server

KEY = 'DUMMY-'+'x'*40
BODY = {'model': server.MODEL, 'messages': [{'role': 'user', 'content': 'DUMMY task'}],
        'stream': False, 'max_tokens': 512, 'temperature': .6,
        'chat_template_kwargs': {'enable_thinking': False}}


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.result = ('DUMMY response', 'stop')
        self.entered, self.release = threading.Event(), threading.Event()
        self.block = False
        def generate(messages):
            self.calls.append(messages)
            if self.block:
                self.entered.set()
                if not self.release.wait(2):raise RuntimeError('Dummy timeout')
            if isinstance(self.result, Exception):
                raise self.result
            return self.result
        self.http = server.BoundedServer(('127.0.0.1', 0), server.make_handler(generate, KEY))
        self.thread = threading.Thread(target=self.http.serve_forever, kwargs={'poll_interval': .01})
        self.thread.start()
        self.port = self.http.server_port

    def tearDown(self):
        self.release.set()
        self.http.shutdown()
        self.thread.join(2)
        self.http.server_close()

    def request(self, body=BODY, path='/v1/chat/completions', method='POST', key=KEY):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=3)
        try:
            data = json.dumps(body).encode() if not isinstance(body, bytes) else body
            conn.request(method, path, data if method == 'POST' else None,
                         headers={'Authorization': 'Bearer '+key, 'Content-Type': 'application/json'})
            response = conn.getresponse()
            return response.status, response.read(), dict(response.getheaders())
        finally:
            conn.close()

    def test_authenticated_chat_and_health_match_gateway_contract(self):
        status, data, headers = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)['choices'][0]['message'], {'role': 'assistant', 'content': 'DUMMY response'})
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertEqual(self.request(method='GET', path='/health')[0], 200)
        self.assertEqual(json.loads(self.request(method='GET', path='/v1/models')[1])['data'][0]['id'], server.MODEL)

    def test_unauthenticated_calls_never_reach_engine(self):
        for path in ('/health', '/v1/models', '/v1/chat/completions'):
            self.assertEqual(self.request(path=path, key='DUMMY-wrong')[0], 401)
        self.assertEqual(self.calls, [])

    def test_no_admin_tools_files_urls_templates_or_alternate_models(self):
        for field, value in [('tools', []), ('tool_choice', 'auto'), ('chat_template', 'DUMMY'),
                             ('model', '/tmp/DUMMY'), ('stream', True), ('max_tokens', 10000)]:
            body = copy.deepcopy(BODY);body[field] = value
            self.assertEqual(self.request(body)[0], 400)
        for path in ('/api/exec', '/v1/files', '/load_model', '/docs', '/v1/chat/completions?tools=true'):
            self.assertEqual(self.request(path=path)[0], 404)
        self.assertEqual(self.calls, [])

    def test_system_tool_multimedia_and_empty_messages_refused(self):
        for messages in ([{'role': 'system', 'content': 'DUMMY'}],
                         [{'role': 'tool', 'content': 'DUMMY'}],
                         [{'role': 'user', 'content': [{'type': 'image_url', 'image_url': 'https://dummy.invalid'}]}],
                         [{'role': 'user', 'content': ' '}], []):
            body = copy.deepcopy(BODY);body['messages'] = messages
            self.assertEqual(self.request(body)[0], 400)
        self.assertEqual(self.calls, [])

    def test_duplicate_json_nonfinite_and_bounded_unicode(self):
        raw = json.dumps(BODY).replace('"model":', '"model":"DUMMY-other","model":').encode()
        self.assertEqual(self.request(raw)[0], 400)
        self.assertEqual(self.request(b'{"temperature":NaN}')[0], 400)
        body = copy.deepcopy(BODY);body['messages'][0]['content'] = '\U0001f600'*3001
        self.assertEqual(self.request(body)[0], 400)
        self.assertEqual(self.calls, [])

    def test_oversized_body_refused(self):
        self.assertEqual(self.request(b'x'*(server.MAX_BODY+1))[0], 400)
        self.assertEqual(self.calls, [])

    def test_health_remains_available_during_one_generation_and_second_is_refused(self):
        self.block = True
        result = []
        worker = threading.Thread(target=lambda: result.append(self.request()[0]))
        worker.start()
        try:
            self.assertTrue(self.entered.wait(1))
            self.assertEqual(self.request(method='GET', path='/health')[0], 200)
            self.assertEqual(self.request()[0], 429)
            self.assertEqual(len(self.calls), 1)
        finally:
            self.release.set();worker.join(2)
        self.assertEqual(result, [200])

    def test_ambiguous_http_framing_refused(self):
        for extra in ('Content-Length: 2\r\nContent-Length: 2',
                      'Content-Length: 2\r\nTransfer-Encoding: chunked',
                      'Content-Length: 2\r\nExpect: 100-continue',
                      'Content-Length: 2\r\nAuthorization: Bearer '+KEY):
            with socket.create_connection(('127.0.0.1', self.port), timeout=3) as peer:
                peer.sendall(('POST /v1/chat/completions HTTP/1.1\r\nHost: dummy\r\nAuthorization: Bearer '+KEY+
                              '\r\nContent-Type: application/json\r\n'+extra+'\r\n\r\n{}').encode())
                response = peer.recv(4096)
                self.assertNotIn(b' 200 ', response.split(b'\r\n')[0])
        self.assertEqual(self.calls, [])

    def test_exception_and_output_contract_fail_closed_without_disclosure(self):
        self.result = RuntimeError('DUMMY private canary '+KEY)
        status, data, _ = self.request()
        self.assertEqual(status, 503);self.assertNotIn(KEY.encode(), data);self.assertNotIn(b'canary', data)
        for result in [('DUMMY', 'tool_calls'), ('x'*12001, 'stop'), (None, 'stop'), ('\0'*12000, 'stop')]:
            self.result = result
            self.assertEqual(self.request()[0], 503)


class EngineSettingsTests(unittest.TestCase):
    def test_offline_single_process_is_mandatory(self):
        with patch.dict(os.environ, {'VLLM_ENABLE_V1_MULTIPROCESSING': '1'}):
            with self.assertRaises(ValueError):server.engine_options('/opt/qwen-model')
        with patch.dict(os.environ, {'VLLM_ENABLE_V1_MULTIPROCESSING': '0'}):
            with self.assertRaises(ValueError):server.engine_options('/tmp/DUMMY')
            options = server.engine_options('/opt/qwen-model')
            self.assertEqual(options['distributed_executor_backend'], 'uni')
            self.assertIs(options['trust_remote_code'], False)
            self.assertEqual(options['allowed_local_media_path'], '')


if __name__ == '__main__':
    unittest.main()
