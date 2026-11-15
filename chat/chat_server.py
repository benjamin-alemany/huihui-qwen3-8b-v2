"""Bounded chat-only adapter for pinned vLLM's synchronous in-process engine.

Only call serve after credential, kernel-network and offline-cache verification.
No tool, file, URL, model-selection, template, upload, admin or streaming APIs.
"""
import hmac
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from socketserver import ThreadingMixIn
import threading

MODEL = 'huihui-qwen3-8b-v2'
MAX_BODY = 16384
FIELDS = {'model', 'messages', 'stream', 'max_tokens', 'temperature', 'chat_template_kwargs'}


class BoundedServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    block_on_close = False
    request_queue_size = 8

    def __init__(self, *args, **kwargs):
        self.slots = threading.BoundedSemaphore(4)
        super().__init__(*args, **kwargs)

    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()

    def handle_error(self, request, address):
        pass  # No traceback, request or prompt data in public logs.


def conversation(body):
    if not isinstance(body, dict) or set(body) != FIELDS:
        raise ValueError('Unsupported request')
    if (body['model'] != MODEL or body['stream'] is not False
            or type(body['max_tokens']) is not int or body['max_tokens'] != 512
            or type(body['temperature']) not in (float, int) or body['temperature'] != .6
            or not isinstance(body['chat_template_kwargs'], dict)
            or set(body['chat_template_kwargs']) != {'enable_thinking'}
            or body['chat_template_kwargs']['enable_thinking'] is not False):
        raise ValueError('Unsupported settings')
    messages = body['messages']
    if not isinstance(messages, list) or not 1 <= len(messages) <= 25 or len(messages) % 2 != 1:
        raise ValueError('Invalid conversation')
    total = 0
    for i, message in enumerate(messages):
        if (not isinstance(message, dict) or set(message) != {'role', 'content'}
                or message['role'] != ('user' if i % 2 == 0 else 'assistant')
                or not isinstance(message['content'], str) or not message['content'].strip()):
            raise ValueError('Text messages required')
        # Match JavaScript's UTF-16 length bound, including astral characters.
        total += len(message['content'].encode('utf-16-le')) // 2
        if total > 6000:
            raise ValueError('Conversation too long')
    return messages


def strict_json(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('Duplicate field')
            result[key] = value
        return result
    return json.loads(data.decode('utf-8'), object_pairs_hook=unique,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Non-finite number')))


def engine_options(model_path):
    if model_path != '/opt/qwen-model' or os.environ.get('VLLM_ENABLE_V1_MULTIPROCESSING') != '0':
        raise ValueError('Fixed offline in-process runtime required')
    return dict(model=model_path, tokenizer=model_path, trust_remote_code=False,
                load_format='safetensors', dtype='bfloat16', tensor_parallel_size=1,
                pipeline_parallel_size=1, distributed_executor_backend='uni',
                max_model_len=4096, max_num_seqs=1, gpu_memory_utilization=.90,
                enforce_eager=True, disable_log_stats=True, enable_lora=False,
                allowed_local_media_path='', allowed_media_domains=[], seed=0)


def make_handler(generate, key):
    if not isinstance(key, str) or len(key) < 32:
        raise ValueError('Inference authentication required')
    generation_lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.0'  # One bounded request per connection.
        server_version = 'PrivateChat'
        sys_version = ''

        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def log_message(self, *_):
            pass

        def send_error(self, code, message=None, explain=None):
            self.reply(code, {'error': 'Request rejected'})

        def reply(self, status, body):
            data = json.dumps(body, ensure_ascii=True, allow_nan=False).encode()
            if len(data) > 65536:
                status, data = 503, b'{"error":"Inference unavailable"}'
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(data)
            self.close_connection = True

        def authorized(self):
            values = self.headers.get_all('Authorization', [])
            return len(values) == 1 and hmac.compare_digest(values[0].encode(), ('Bearer '+key).encode())

        def do_GET(self):
            if not self.authorized():
                return self.reply(401, {'error': 'Unauthorized'})
            if self.path == '/health':
                return self.reply(200, {'status': 'ready', 'agent_tools_enabled': False})
            if self.path == '/v1/models':
                return self.reply(200, {'data': [{'id': MODEL, 'object': 'model'}]})
            return self.reply(404, {'error': 'Unknown endpoint'})

        def do_POST(self):
            if not self.authorized():
                return self.reply(401, {'error': 'Unauthorized'})
            if self.path != '/v1/chat/completions':
                return self.reply(404, {'error': 'Unknown endpoint'})
            lengths = self.headers.get_all('Content-Length', [])
            if (self.headers.get_all('Transfer-Encoding') or self.headers.get_all('Expect')
                    or len(lengths) != 1 or not lengths[0].isascii() or not lengths[0].isdigit()
                    or len(lengths[0]) > 6 or not 0 < int(lengths[0]) <= MAX_BODY
                    or self.headers.get_all('Content-Type') != ['application/json']):
                return self.reply(400, {'error': 'Invalid framing'})
            try:
                data = self.rfile.read(int(lengths[0]))
                if len(data) != int(lengths[0]):
                    raise ValueError('Incomplete body')
                messages = conversation(strict_json(data))
            except (ValueError, UnicodeError, OSError, RecursionError):
                return self.reply(400, {'error': 'Invalid text request'})
            if not generation_lock.acquire(blocking=False):
                return self.reply(429, {'error': 'Inference busy'})
            try:
                content, reason = generate(messages)
                if not isinstance(content, str) or len(content.encode('utf-8')) > 12000 or reason not in ('stop', 'length'):
                    raise ValueError('Unexpected output')
                return self.reply(200, {'model': MODEL, 'choices': [{'index': 0,
                    'message': {'role': 'assistant', 'content': content}, 'finish_reason': reason}]})
            except Exception:
                # Never serialize upstream exception text, prompts, paths or keys.
                return self.reply(503, {'error': 'Inference unavailable'})
            finally:
                generation_lock.release()

    return Handler


def serve(model_path):
    from vllm import LLM, SamplingParams
    options = engine_options(model_path)
    llm = LLM(**options)
    # Refuse a future dependency silently selecting a different IPC/executor path.
    from vllm.v1.engine.core_client import InprocClient
    from vllm.v1.executor.uniproc_executor import UniProcExecutor
    core = llm.llm_engine.engine_core
    if type(core) is not InprocClient or type(core.engine_core.model_executor) is not UniProcExecutor:
        raise ValueError('Unexpected engine transport')
    params = SamplingParams(max_tokens=512, temperature=.6, n=1)

    def generate(messages):
        outputs = llm.chat(messages, params, use_tqdm=False, tools=None,
                           chat_template_content_format='string',
                           chat_template_kwargs={'enable_thinking': False})
        if len(outputs) != 1 or len(outputs[0].outputs) != 1:
            raise ValueError('Unexpected response count')
        item = outputs[0].outputs[0]
        return item.text, item.finish_reason

    # One synchronous inference at a time. Bounded HTTP threads keep health checks
    # responsive during generation, without any worker process/named IPC server.
    # A separate supervisor and cloud guards retain the fixed session deadline.
    with BoundedServer(('0.0.0.0', 8000), make_handler(generate, os.environ['VLLM_API_KEY'])) as server:
        print('CHAT_READY inbound-only chat; agent tools disabled', flush=True)
        server.serve_forever()
