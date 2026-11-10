"""Model-free CPU analogue of the pinned single-rank Torch/Gloo transport path.

This is NOT a vLLM/CUDA/Runpod compatibility pass. No weights or cloud API.
Run in a clean disposable Linux CPU environment with the hash-pinned CPU wheels.
"""
import os
from pathlib import Path
import sys
import tempfile
from datetime import timedelta

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import network_boundary

os.environ.update(OMP_NUM_THREADS='1', MKL_NUM_THREADS='1')
receipt = network_boundary.install()  # Before Torch imports and native threads.
import torch
import torch.distributed as dist

if torch.__version__ != '2.13.0+cpu' or not dist.is_gloo_available():
    raise RuntimeError('Pinned CPU fixture required')
with tempfile.TemporaryDirectory(prefix='qwen-gloo-dummy-') as directory:
    dist.init_process_group('gloo', init_method=Path(directory, 'store').as_uri(),
                            rank=0, world_size=1, timeout=timedelta(seconds=12))
    groups = []
    try:
        # vLLM constructs both world and model groups even at world_size=1.
        for _ in range(3):
            group = dist.new_group([0], backend='gloo', timeout=timedelta(seconds=12))
            groups.append(group)
            tensor = torch.tensor([7], dtype=torch.int64)
            dist.all_reduce(tensor, group=group)
            dist.broadcast(tensor, src=0, group=group)
            dist.barrier(group=group)
            if tensor.item() != 7:
                raise RuntimeError('Unexpected dummy collective result')
    finally:
        for group in reversed(groups):
            dist.destroy_process_group(group)
        dist.destroy_process_group()
print('CPU single-rank FileStore/Gloo groups and collectives passed under '+receipt['policy'])
