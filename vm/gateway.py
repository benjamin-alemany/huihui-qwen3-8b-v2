"""Trusted host-only bounded chat gateway; no provider API or shell endpoint.

Outer gateway authentication never enters the model container. The separate
model key is used only by this host process for the fixed private backend.
"""
import hmac,json,os,re,stat,sys,time,urllib.error,urllib.request
from http.server import BaseHTTPRequestHandler,HTTPServer
from pathlib import Path
from socketserver import ThreadingMixIn
import threading
sys.path.insert(0,str(Path(__file__).resolve().parent))
from host_policy import UUID,IMAGE,Refused,timestamp,atomic
MODEL='huihui-qwen3-8b-v2'
CHECKPOINT='huihui-ai/Huihui-Qwen3-8B-abliterated-v2'
REVISION='7d89db76029281fd8f3e6698a8e30738608105a9'
MAX_BODY=16384;MAX_RESPONSE=65536

def strict_json(data):
 def unique(pairs):
  result={}
  for key,value in pairs:
   if key in result:raise Refused('Duplicate JSON field')
   result[key]=value
  return result
 return json.loads(data.decode('utf-8'),object_pairs_hook=unique,parse_constant=lambda _:(_ for _ in ()).throw(Refused('Nonfinite JSON')))

def config_from(c):
 fields={'version','sessionId','nonce','createdAt','deadlineUTC','servingImage','bootstrapLockSha256','bootstrapBundleSha256','model','gatewayKey','modelKey'}
 if not isinstance(c,dict) or set(c)!=fields or type(c['version']) is not int or c['version']!=1 or not UUID.fullmatch(c['sessionId']) or not re.fullmatch('[0-9a-f]{32}',c['nonce']) or not IMAGE.fullmatch(c['servingImage']):raise Refused('Invalid host gateway config')
 if not 0<timestamp(c['deadlineUTC'])-timestamp(c['createdAt'])<=3600:raise Refused('Invalid host gateway expiry')
 for key in ['bootstrapLockSha256','bootstrapBundleSha256','gatewayKey','modelKey']:
  if not isinstance(c[key],str) or not re.fullmatch('[0-9a-f]{64}',c[key]):raise Refused('Invalid pinned gateway input')
 if c['gatewayKey']==c['modelKey'] or c['model']!={'name':CHECKPOINT,'revision':REVISION}:raise Refused('Separated keys and fixed model required')
 return c

def protected_group_file(path):
 p=Path(path);s=p.lstat()
 if stat.S_ISLNK(s.st_mode) or not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_gid!=10002 or s.st_mode&0o027 or not s.st_mode&stat.S_IRGRP:raise Refused('Root-owned gateway-only read file required')
 return p

def receipt_from(c,r):
 fields={'version','provider','status','sessionId','nonce','servingImage','bootstrapLockSha256','bootstrapBundleSha256','runtimeProfile','createdAt','deadlineUTC','sealed','nativeAttestation','privateNamespaces','modelEgressDenied','offlineCacheVerified','cudaReady','modelName','modelRevision','modelLoaded','agentToolsEnabled'}
 if not isinstance(r,dict) or set(r)!=fields or type(r['version']) is not int or r['version']!=1 or r['provider']!='hyperstack' or r['status'] not in ['validated','ready'] or r['modelLoaded'] is not (r['status']=='ready') or r['runtimeProfile']!='vm-inference-v1' or r['agentToolsEnabled'] is not False or r['modelName']!=MODEL or r['modelRevision']!=REVISION:raise Refused('Host readiness unavailable')
 for key in ['sessionId','nonce','servingImage','bootstrapLockSha256','bootstrapBundleSha256','createdAt','deadlineUTC']:
  if r[key]!=c[key]:raise Refused('Host readiness is not this immutable session')
 for key in ['sealed','nativeAttestation','privateNamespaces','modelEgressDenied','offlineCacheVerified','cudaReady']:
  if r[key] is not True:raise Refused('Host readiness gate incomplete')
 return r

def permit_body(c,body):
 if not isinstance(body,dict) or body!={key:c[key] for key in ['sessionId','nonce','deadlineUTC']}:raise Refused('Immutable model permit body required')
 return {'version':1,'status':'permitted',**body}

def record_permit(c,body,directory='/run/unjailed/permissions'):
 acknowledgement=permit_body(c,body);base=Path(directory);info=base.lstat()
 if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or info.st_uid!=10002 or info.st_mode&0o077:raise Refused('Private gateway permit directory required')
 path=base/'model-request.json';value={'version':1,**body}
 if path.exists():
  info=path.lstat()
  if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_uid!=10002 or info.st_mode&0o077 or strict_json(path.read_bytes())!=value:raise Refused('Existing immutable permit differs')
 else:atomic(path,value)
 return acknowledgement

def bounded_request(body):
 fields={'model','messages','stream','max_tokens','temperature','chat_template_kwargs'}
 if not isinstance(body,dict) or set(body)!=fields or body['model']!=MODEL or body['stream'] is not False or type(body['max_tokens']) is not int or body['max_tokens']!=512 or type(body['temperature']) not in [int,float] or body['temperature']!=.6 or not isinstance(body['chat_template_kwargs'],dict) or set(body['chat_template_kwargs'])!={'enable_thinking'} or body['chat_template_kwargs']['enable_thinking'] is not False:raise Refused('Bounded chat only')
 messages=body['messages'];total=0
 if not isinstance(messages,list) or not 1<=len(messages)<=25 or len(messages)%2!=1:raise Refused('Text conversation required')
 for index,message in enumerate(messages):
  if not isinstance(message,dict) or set(message)!={'role','content'} or message['role']!=('user' if index%2==0 else 'assistant') or not isinstance(message['content'],str) or not message['content'].strip():raise Refused('Text conversation required')
  total+=len(message['content'].encode('utf-16-le'))//2
 if total>6000:raise Refused('Conversation bound exceeded')
 return body

def bounded_response(body):
 if not isinstance(body,dict) or set(body)!={'model','choices'} or body['model']!=MODEL or not isinstance(body['choices'],list) or len(body['choices'])!=1:raise Refused('Unexpected model response')
 choice=body['choices'][0]
 if not isinstance(choice,dict) or set(choice)!={'index','message','finish_reason'} or choice['index']!=0 or choice['finish_reason'] not in ['stop','length']:raise Refused('Unexpected model response')
 message=choice['message']
 if not isinstance(message,dict) or set(message)!={'role','content'} or message['role']!='assistant' or not isinstance(message['content'],str) or len(message['content'].encode())>12000:raise Refused('Unexpected model response')
 return body

def backend(c,path,body=None):
 if path not in ['/health','/v1/chat/completions']:raise Refused('Fixed backend route required')
 payload=None if body is None else json.dumps(bounded_request(body),ensure_ascii=True,allow_nan=False).encode()
 headers={'Authorization':'Bearer '+c['modelKey'],'Accept':'application/json'}
 if payload is not None:headers['Content-Type']='application/json'
 request=urllib.request.Request('http://10.203.0.2:8000'+path,data=payload,headers=headers,method='GET' if payload is None else 'POST')
 class NoRedirect(urllib.request.HTTPRedirectHandler):
  def redirect_request(self,*_):raise Refused('Backend redirect forbidden')
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
 with opener.open(request,timeout=2 if payload is None else 100) as response:
  if response.status!=200 or response.headers.get_content_type()!='application/json':raise Refused('Backend unavailable')
  data=response.read(MAX_RESPONSE+1)
 if len(data)>MAX_RESPONSE:raise Refused('Backend response bound exceeded')
 value=strict_json(data)
 if payload is None:
  if value!={'status':'ready','agent_tools_enabled':False}:raise Refused('Backend health refused')
  return value
 return bounded_response(value)

def handler(c,ready,forward,now=time.time,permit=None):
 wall,mono=time.time(),time.monotonic();slots=threading.BoundedSemaphore(4);generation=threading.Lock();permission=threading.Lock()
 def current(require_ready=False):
  value=max(now(),wall+time.monotonic()-mono)
  if not timestamp(c['createdAt'])<=value<timestamp(c['deadlineUTC']):raise Refused('Session expired')
  receipt=receipt_from(c,ready())
  if require_ready and receipt['status']!='ready':raise Refused('Model not permitted/ready')
  return receipt
 class Handler(BaseHTTPRequestHandler):
  protocol_version='HTTP/1.0';server_version='PrivateChat';sys_version=''
  def setup(self):super().setup();self.connection.settimeout(10)
  def log_message(self,*_):pass
  def send_error(self,*_):self.reply(400,{'error':'Request rejected'})
  def reply(self,status,body):
   data=json.dumps(body,ensure_ascii=True,allow_nan=False).encode()
   if len(data)>MAX_RESPONSE:status,data=503,b'{"error":"Inference unavailable"}'
   self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.send_header('Cache-Control','no-store');self.send_header('Connection','close');self.end_headers();self.wfile.write(data);self.close_connection=True
  def authenticated(self):
   values=self.headers.get_all('Authorization',[])
   return len(values)==1 and hmac.compare_digest(values[0].encode(),('Bearer '+c['gatewayKey']).encode())
  def do_GET(self):
   if not self.authenticated():return self.reply(401,{'error':'Unauthorized'})
   try:
    receipt=current()
    if self.path=='/__unjailed/host-ready':return self.reply(200,receipt)
    if self.path=='/health':current(True);forward('/health');current(True);return self.reply(200,{'status':'ready','agent_tools_enabled':False})
    if self.path=='/v1/models':current(True);return self.reply(200,{'data':[{'id':MODEL,'object':'model'}]})
    return self.reply(404,{'error':'Unknown endpoint'})
   except Exception:return self.reply(503,{'error':'Inference unavailable'})
  def do_POST(self):
   if not self.authenticated():return self.reply(401,{'error':'Unauthorized'})
   if self.path not in ['/v1/chat/completions','/__unjailed/allow-model']:return self.reply(404,{'error':'Unknown endpoint'})
   lengths=self.headers.get_all('Content-Length',[])
   if self.headers.get_all('Transfer-Encoding') or self.headers.get_all('Expect') or len(lengths)!=1 or not lengths[0].isascii() or not lengths[0].isdigit() or len(lengths[0])>6 or not 0<int(lengths[0])<=MAX_BODY or self.headers.get_all('Content-Type')!=['application/json']:return self.reply(400,{'error':'Invalid framing'})
   if self.path=='/__unjailed/allow-model':
    try:
     if int(lengths[0])>1024:raise Refused('Permit body too large')
     current();data=self.rfile.read(int(lengths[0]))
     if len(data)!=int(lengths[0]):raise Refused('Incomplete permit')
     body=strict_json(data);permit_body(c,body)
     if permit is None:raise Refused('Trusted permit recorder unavailable')
     with permission:current();acknowledgement=permit(body);current()
     return self.reply(200,acknowledgement)
    except Exception:return self.reply(409,{'error':'Model permit refused'})
   if not generation.acquire(blocking=False):return self.reply(429,{'error':'Inference busy'})
   try:
    current(True);data=self.rfile.read(int(lengths[0]))
    if len(data)!=int(lengths[0]):raise Refused('Incomplete body')
    value=forward('/v1/chat/completions',bounded_request(strict_json(data)));current(True);return self.reply(200,bounded_response(value))
   except Exception:return self.reply(503,{'error':'Inference unavailable'})
   finally:generation.release()
 return Handler,slots

class Server(ThreadingMixIn,HTTPServer):
 daemon_threads=True;block_on_close=False;request_queue_size=8
 def process_request(self,request,address):
  if not self.slots.acquire(blocking=False):self.shutdown_request(request);return
  try:super().process_request(request,address)
  except BaseException:self.slots.release();raise
 def process_request_thread(self,request,address):
  try:super().process_request_thread(request,address)
  finally:self.slots.release()
 def handle_error(self,*_):pass

def main():
 if sys.platform!='linux' or os.getresuid()!=(10002,)*3 or os.getresgid()!=(10002,)*3:raise Refused('Dedicated host gateway identity required')
 c=config_from(strict_json(protected_group_file('/etc/unjailed/gateway.json').read_bytes()))
 if sys.argv[1:]==['--probe-model']:
  if not timestamp(c['createdAt'])<=time.time()<timestamp(c['deadlineUTC']):raise Refused('Session expired')
  backend(c,'/health');print('FIXED_PRIVATE_MODEL_HEALTH_PASSED');return
 if sys.argv[1:]:raise Refused('No arbitrary gateway operation')
 ready=lambda:strict_json(protected_group_file('/run/unjailed/host-ready.json').read_bytes())
 Handler,slots=handler(c,ready,lambda path,body=None:backend(c,path,body),permit=lambda body:record_permit(c,body))
 with Server(('127.0.0.1',8765),Handler) as server:server.slots=slots;server.serve_forever()
if __name__=='__main__':
 try:main()
 except Exception:raise SystemExit('Trusted host gateway refused')
