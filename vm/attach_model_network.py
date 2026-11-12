"""Trusted root veth attach to one owned, pinned container network namespace."""
import json,os,re,subprocess,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from host_policy import root_file,manifest_from,Refused
ENV={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C'}
def run(args,**options):
 r=subprocess.run(args,env=ENV,capture_output=True,text=True,timeout=20,**options)
 if r.returncode:raise Refused('Trusted namespace operation refused')
 return r.stdout.strip()
def inspect(name,field):return json.loads(run(['docker','inspect','--format','{{json '+field+'}}',name]))
def owned(m,name,state,config,image,labels,container_id):
 if name!='uj-model-'+m['sessionId'] or labels.get('unjailed.session')!=m['sessionId'] or image!=m['image'] or not re.fullmatch('[0-9a-f]{64}',container_id):raise Refused('Owned container identity mismatch')
 if not state.get('Running') or type(state.get('Pid')) is not int or state['Pid']<=1:raise Refused('Container not running')
 if config.get('NetworkMode')!='none' or config.get('PidMode') not in ('',None) or config.get('IpcMode')!='private' or config.get('Privileged') or not config.get('ReadonlyRootfs') or set(config.get('CapDrop',[]))!={'ALL'} or set(config.get('CapAdd',[]))!={'SETUID','SETGID'} or 'no-new-privileges' not in config.get('SecurityOpt',[]):raise Refused('Private runtime configuration mismatch')
 if config.get('PortBindings'):raise Refused('Published model port forbidden')
def main():
 if os.geteuid()!=0 or sys.platform!='linux':raise Refused('Reviewed Linux root host required')
 m=manifest_from(json.loads(root_file('/etc/unjailed/session.json').read_text()));name='uj-model-'+m['sessionId']
 state=inspect(name,'.State');config=inspect(name,'.HostConfig');container_id=inspect(name,'.Id')
 owned(m,name,state,config,inspect(name,'.Config.Image'),inspect(name,'.Config.Labels'),container_id)
 run(['nft','list','table','inet','unjailed'])
 # Pin /proc directory and namespace FD; never chase a recycled numeric PID.
 proc=os.open('/proc/'+str(state['Pid']),os.O_RDONLY|os.O_DIRECTORY)
 try:
  cgroup_fd=os.open('cgroup',os.O_RDONLY,dir_fd=proc)
  with os.fdopen(cgroup_fd) as stream:cgroup=stream.read()
  if container_id not in cgroup:raise Refused('Container process identity changed')
  net=os.open('ns/net',os.O_RDONLY,dir_fd=proc)
 finally:os.close(proc)
 target=Path('/run/netns/uj-model');target.parent.mkdir(mode=0o755,exist_ok=True)
 try:
  fd=os.open(target,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600);os.close(fd)
  run(['mount','--bind','/proc/self/fd/'+str(net),str(target)],pass_fds=(net,))
  # Existing interfaces/setup refuse; root orchestrator may not silently retry.
  existing=subprocess.run(['ip','link','show','uj-m-host'],env=ENV,capture_output=True,timeout=10)
  if existing.returncode==0:raise Refused('Prior network setup requires review')
  run(['ip','link','add','uj-m-host','type','veth','peer','name','uj-m-peer'])
  run(['ip','link','set','uj-m-peer','netns','uj-model'])
  run(['ip','-n','uj-model','link','set','uj-m-peer','name','eth0'])
  run(['ip','-n','uj-model','addr','add','10.203.0.2/24','dev','eth0'])
  run(['ip','-n','uj-model','link','set','eth0','up'])
  run(['ip','addr','add','10.203.0.1/24','dev','uj-m-host']);run(['ip','link','set','uj-m-host','up'])
  if run(['ip','-n','uj-model','route','show','default']) or run(['ip','-n','uj-model','-6','route','show','default']):raise Refused('Unexpected model default route')
 finally:os.close(net)
 print('OWNED_PRIVATE_MODEL_VETH_ATTACHED_NO_DEFAULT_ROUTE')
if __name__=='__main__':
 try:main()
 except Exception:raise SystemExit('Private model network refused; no unrestricted fallback')
