"""Portable dummy responses only; no sockets, provider, model or credentials."""
import copy,datetime as dt,email.message,io,json,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
import gateway
from attestation import context_digest,verify_model_permit
from host_policy import Refused
from run import preflight_from_logs

class GatewayTests(unittest.TestCase):
 def fixture(self):
  now=dt.datetime.now(dt.timezone.utc);iso=lambda t:t.isoformat().replace('+00:00','Z')
  return {'version':1,'sessionId':'11111111-1111-4111-8111-111111111111','nonce':'b'*32,'createdAt':iso(now-dt.timedelta(seconds=1)),'deadlineUTC':iso(now+dt.timedelta(minutes=30)),'servingImage':'ghcr.io/benjamin-alemany/huihui-qwen3-8b-v2@sha256:'+'c'*64,'bootstrapLockSha256':'d'*64,'bootstrapBundleSha256':'e'*64,'model':{'name':gateway.CHECKPOINT,'revision':gateway.REVISION},'gatewayKey':'1'*64,'modelKey':'2'*64}
 def receipt(self,c,status='ready'):
  return {'version':1,'provider':'hyperstack','status':status,**{k:c[k] for k in ['sessionId','nonce','createdAt','deadlineUTC','servingImage','bootstrapLockSha256','bootstrapBundleSha256']},'runtimeProfile':'vm-inference-v1','sealed':True,'nativeAttestation':True,'privateNamespaces':True,'modelEgressDenied':True,'offlineCacheVerified':True,'cudaReady':True,'modelName':gateway.MODEL,'modelRevision':gateway.REVISION,'modelLoaded':status=='ready','agentToolsEnabled':False}
 def body(self):return {'model':gateway.MODEL,'messages':[{'role':'user','content':'DUMMY'}],'stream':False,'max_tokens':512,'temperature':.6,'chat_template_kwargs':{'enable_thinking':False}}
 def response(self):return {'model':gateway.MODEL,'choices':[{'index':0,'message':{'role':'assistant','content':'DUMMY'},'finish_reason':'stop'}]}
 def request(self,c,receipt,path,method='GET',body=None,authorization=None,forward=None,permit=None,now=None):
  calls=[]
  def default_forward(route,payload=None):calls.append((route,payload));return self.response() if payload else {'status':'ready','agent_tools_enabled':False}
  H,_=gateway.handler(c,lambda:receipt,forward or default_forward,permit=permit,**({'now':now} if now else {}));h=object.__new__(H)
  h.path=path;h.command=method;h.headers=email.message.Message();h.headers['Authorization']='Bearer '+(c['gatewayKey'] if authorization is None else authorization)
  data=b'' if body is None else json.dumps(body).encode();h.rfile=io.BytesIO(data);h.wfile=io.BytesIO();h.headers['Content-Type']='application/json';h.headers['Content-Length']=str(len(data));status=[]
  h.send_response=lambda value:status.append(value);h.send_header=lambda *_:None;h.end_headers=lambda:None
  (h.do_GET if method=='GET' else h.do_POST)()
  return status[0],json.loads(h.wfile.getvalue()),calls
 def test_distinct_gateway_key_and_fixed_checkpoint_pins(self):
  c=self.fixture();gateway.config_from(c)
  for patch in [{'modelKey':c['gatewayKey']},{'providerKey':'DUMMY'},{'servingImage':'image:latest'},{'model':{'name':gateway.CHECKPOINT,'revision':'0'*40}}]:
   with self.assertRaises(Refused):gateway.config_from({**c,**patch})
 def test_host_readiness_is_local_and_not_forwarded_to_model(self):
  c=self.fixture();status,r,calls=self.request(c,self.receipt(c,'validated'),'/__unjailed/host-ready');self.assertEqual(status,200);self.assertFalse(r['modelLoaded']);self.assertEqual(calls,[])
  for mutate in [{'sealed':False},{'nonce':'0'*32},{'modelLoaded':True},{'modelName':gateway.CHECKPOINT},{'extra':'DUMMY'}]:
   self.assertEqual(self.request(c,{**self.receipt(c,'validated'),**mutate},'/__unjailed/host-ready')[0],503)
 def test_model_key_cannot_authenticate_outer_gateway(self):
  c=self.fixture();self.assertEqual(self.request(c,self.receipt(c),'/v1/chat/completions','POST',self.body(),authorization=c['modelKey'])[0],401)
 def test_chat_refuses_until_ready_and_exposes_only_fixed_routes(self):
  c=self.fixture();self.assertEqual(self.request(c,self.receipt(c,'validated'),'/v1/chat/completions','POST',self.body())[0],503)
  self.assertEqual(self.request(c,self.receipt(c),'/v1/chat/completions','POST',self.body())[0],200)
  self.assertEqual(self.request(c,self.receipt(c),'/terminal','POST',{})[0],404)
  bad={**self.body(),'tools':[{'name':'DUMMY'}]};self.assertEqual(self.request(c,self.receipt(c),'/v1/chat/completions','POST',bad)[0],503)
 def test_expiry_rechecked_after_model_reply(self):
  c=self.fixture();clock=[gateway.timestamp(c['createdAt'])+1]
  def forward(*_):clock[0]=gateway.timestamp(c['deadlineUTC'])+1;return self.response()
  self.assertEqual(self.request(c,self.receipt(c),'/v1/chat/completions','POST',self.body(),forward=forward,now=lambda:clock[0])[0],503)
 def test_permit_exact_body_and_acknowledgement(self):
  c=self.fixture();body={k:c[k] for k in ['sessionId','nonce','deadlineUTC']};recorded=[]
  def permit(value):recorded.append(value);return gateway.permit_body(c,value)
  status,ack,calls=self.request(c,self.receipt(c,'validated'),'/__unjailed/allow-model','POST',body,permit=permit)
  self.assertEqual(status,200);self.assertEqual(ack,{'version':1,'status':'permitted',**body});self.assertEqual(recorded,[body]);self.assertEqual(calls,[])
  for patch in [{'nonce':'0'*32},{'modelKey':'DUMMY'},{'deadlineUTC':'2099-01-01T00:00:00Z'}]:
   self.assertEqual(self.request(c,self.receipt(c,'validated'),'/__unjailed/allow-model','POST',{**body,**patch},permit=permit)[0],409)
 def test_native_preflight_requires_context_bound_real_cuda_profile(self):
  c=self.fixture();context={'version':1,**{k:c[k] for k in ['sessionId','nonce','createdAt','deadlineUTC']},'image':c['servingImage'],'containerId':'a'*64,'imageId':'sha256:'+'b'*64}
  proof={'version':1,'kind':'vm-native-cuda-v1','offlineCacheVerified':True,'cudaReady':True,'modelLoaded':False,'agentToolsEnabled':False,'contextSHA256':context_digest(context)}
  self.assertEqual(preflight_from_logs('VM_PREFLIGHT '+json.dumps(proof),context),proof);self.assertIsNone(preflight_from_logs('',context))
  for patch in [{'kind':'vm-cpu-fixture-v1','cudaReady':False},{'contextSHA256':'0'*64},{'offlineCacheVerified':False}]:
   with self.assertRaises(Refused):preflight_from_logs('VM_PREFLIGHT '+json.dumps({**proof,**patch}),context)
  permit={'version':1,'sessionId':c['sessionId'],'nonce':c['nonce'],'deadlineUTC':c['deadlineUTC'],'contextSHA256':context_digest(context)}
  verify_model_permit(context,permit,c['createdAt'],c['deadlineUTC'])
  with self.assertRaises(Refused):verify_model_permit(context,{**permit,'nonce':'0'*32},c['createdAt'],c['deadlineUTC'])
 def test_duplicate_json_and_response_bounds(self):
  with self.assertRaises(Refused):gateway.strict_json(b'{"x":1,"x":2}')
  with self.assertRaises(Refused):gateway.bounded_response({**self.response(),'arbitrary':'DUMMY'})
  bad=self.response();bad['choices'][0]['message']['content']='x'*12001
  with self.assertRaises(Refused):gateway.bounded_response(bad)
if __name__=='__main__':unittest.main()
