"""Verify small vendor metadata only. Never downloads/executes a package payload."""
import gzip,hashlib,io,json,re,subprocess,tempfile,urllib.request
from pathlib import Path
HERE=Path(__file__).resolve().parent
class Refused(ValueError): pass

def records(raw):
    result=[]
    for block in raw.decode('utf-8').strip().split('\n\n'):
        row={};key=None
        for line in block.splitlines():
            if line.startswith((' ','\t')) and key:row[key]+=' '+line.strip()
            elif ': ' in line:key,value=line.split(': ',1);row[key]=value
        if row.get('Package'):result.append(row)
    return result

def fetch(url,limit):
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(url,timeout=25) as reply:
        if reply.geturl()!=url:raise Refused('Metadata redirect refused')
        raw=reply.read(limit+1)
    if len(raw)>limit:raise Refused('Metadata exceeds bound')
    return raw

def verify_index(release,index,name,algorithm):
    section=release.decode().split(algorithm.upper()+':',1)
    if len(section)!=2:raise Refused('Signed index digest absent')
    rows=[line.split() for line in section[1].splitlines()]
    matches=[r for r in rows if len(r)==3 and r[2]==name]
    if len(matches)!=1 or int(matches[0][1])!=len(index) or hashlib.new(algorithm,index).hexdigest()!=matches[0][0]:raise Refused('Signed index digest mismatch')

def verify(lock,read=fetch,gpgv='gpgv'):
    proofs={}
    for name,repo in lock['repositories'].items():
        key=HERE/'keys'/(name+'.gpg')
        if hashlib.sha256(key.read_bytes()).hexdigest()!=repo['key_sha256']:raise Refused('Vendor key bytes changed')
        base=repo.get('release_base',repo['base'])
        release=read(base+'InRelease',256*1024);index=read(base+repo['index'],12*1024*1024)
        with tempfile.TemporaryDirectory(prefix='unjailed-public-gpg-') as directory:
            p=Path(directory)/'InRelease';p.write_bytes(release)
            checked=subprocess.run([gpgv,'--homedir',directory,'--status-fd','1','--keyring',str(key),str(p)],capture_output=True,text=True,timeout=15)
            signatures=[line.split() for line in checked.stdout.splitlines() if line.startswith('[GNUPG:] VALIDSIG ')]
            if checked.returncode or not any(repo['fingerprint'] in (r[2],r[-1]) for r in signatures):raise Refused('Vendor signature refused')
        verify_index(release,index,repo['index'],repo['algorithm'])
        if repo['index'].endswith('.gz'):
            with gzip.GzipFile(fileobj=io.BytesIO(index)) as stream:raw=stream.read(32*1024*1024+1)
            if len(raw)>32*1024*1024:raise Refused('Expanded metadata too large')
        else:raw=index
        available=records(raw)
        for p in (p for p in lock['packages'] if p['repository']==name):
            candidates=[r for r in available if (r.get('Package'),r.get('Version'),r.get('Architecture'))==(p['name'],p['version'],p['architecture'])]
            if not any(r.get('SHA256')==p['sha256'] and int(r['Size'])==p['size'] and r['Filename']==p['filename'] for r in candidates):raise Refused('Pinned package missing or changed')
        proofs[name]={'signature_verified':True,'index_digest_verified':True,'inrelease_sha256':hashlib.sha256(release).hexdigest()}
    return proofs
if __name__=='__main__':print(json.dumps(verify(json.loads((HERE/'packages.lock.json').read_text())),sort_keys=True))
