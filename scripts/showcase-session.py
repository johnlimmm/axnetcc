"""One verified management session for isolated deployment, log collection and UI forwarding.
The experiment's Core/Edge data path stays between servers; the PC collects metadata only.
"""
import argparse
import concurrent.futures
import hashlib
import importlib.util
import json
from pathlib import Path
import select
import socketserver
import subprocess
import tarfile
import threading
import time

PROJECT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('transport',PROJECT/'scripts/remote-demo-control.py')
transport=importlib.util.module_from_spec(spec);spec.loader.exec_module(transport)
OUTPUT=PROJECT/'outputs/showcase-20261008'

def remote(client, code, timeout=60):
    stdin,out,err=client.exec_command('python3 -',timeout=timeout)
    stdin.write(code);stdin.flush();stdin.channel.shutdown_write()
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        a=pool.submit(out.read);b=pool.submit(err.read)
        stdout=a.result().decode('utf8','replace');stderr=b.result().decode('utf8','replace')
    if out.channel.recv_exit_status()!=0:
        raise RuntimeError('Remote operation failed: '+stderr[-2000:])
    return stdout

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('action',choices=['deploy','serve','pull','connect-backup','recover','sync-monitor'])
    parser.add_argument('--credential-session',required=True)
    args=parser.parse_args()
    secrets=transport.saved_passwords(args.credential_session)
    clients={};servers=[]
    OUTPUT.mkdir(parents=True,exist_ok=True)
    try:
        clients['hpc']=transport.connect('10.246.246.44',22,'lim921211',password=secrets['hpc'])
        for name,host,port,user,options in [
            ('ai-cloud','116.89.177.90',31055,'jovyan',{'key_filename':str(Path.home()/'Downloads/private.pem')}),
            ('mnckoren','210.114.95.58',22,'mnckoren',{'password':secrets['hub']})]:
            channel=clients['hpc'].get_transport().open_channel('direct-tcpip',(host,port),('127.0.0.1',0),timeout=8)
            clients[name]=transport.connect(host,port,user,sock=channel,**options)
        transport.emit({'authenticatedNodes':list(clients),'action':args.action})
        if args.action=='connect-backup':
            key=clients['ai-cloud'].get_transport().get_remote_server_key()
            known=f'[116.89.177.90]:31055 {key.get_name()} {key.get_base64()}\n'
            # Linux anonymous memfd: private material is never written to a filesystem file.
            private=(Path.home()/'Downloads/private.pem').read_text()
            code="""import os,json,subprocess,time,socket
from pathlib import Path
r=Path.home()/'axnetcc-showcase-20261008';shared=r/'shared'
known=shared/'ai-known-hosts';known.write_text(KNOWN);known.chmod(0o600)
fd=os.memfd_create('showcase-ssh-key');os.fchmod(fd,0o600);os.write(fd,PRIVATE.encode());PRIVATE=None
argv=['ssh','-N','-M','-S',str(shared/'ai.sock'),'-i',f'/proc/{os.getpid()}/fd/{fd}','-p','31055','-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+str(known),'-o','ExitOnForwardFailure=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=20']
for i in range(8):argv+=['-L',f'127.0.0.1:{26101+i}:127.0.0.1:{6101+i}']
argv+=['jovyan@116.89.177.90']
with (r/'logs/ai-ssh.log').open('ab') as log:p=subprocess.Popen(argv,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True,cwd=r/'release')
ready=False
try:
 for _ in range(40):
  if p.poll() is not None:break
  try:
   connection=socket.create_connection(('127.0.0.1',26101),.2);connection.close();ready=True;break
  except OSError:time.sleep(.25)
finally:os.close(fd)
(shared/'ai-ssh-process.json').write_text(json.dumps({'pid':p.pid,'ownedRoot':str(r),'args':argv}))
print(json.dumps({'backupForwardReady':ready,'pid':p.pid,'dataPath':'HPC-to-ai-cloud-direct','keyStorage':'anonymous-memory-only'}))
if not ready:raise RuntimeError('Backup forward unavailable; see dedicated ai-ssh log')
"""
            result=remote(clients['hpc'],'KNOWN='+repr(known)+'\nPRIVATE='+repr(private)+'\n'+code)
            private=None;secrets.clear();transport.emit(json.loads(result));return
        if args.action=='deploy':
            # Explicit source/artifact roots; never package credentials, hidden state or outputs.
            archive=OUTPUT/'release.tar.gz'
            files=[]
            for folder in ['dist','public','lib','monitor','scripts','app','data','corpus']:
                for p in (PROJECT/folder).rglob('*'):
                    if p.is_file() and not p.is_symlink() and '__pycache__' not in p.parts and not any(part in ['raw','processed','index'] for part in p.relative_to(PROJECT).parts[:2]):
                        files.append(p)
            for name in ['package.json','vite.config.ts','tsconfig.json','next.config.ts']:
                files.append(PROJECT/name)
            with tarfile.open(archive,'w:gz') as bundle:
                for p in files:
                    if p.suffix in ['.pem','.key'] or p.name.startswith('.env'):
                        raise RuntimeError('Secret filename refused')
                    bundle.add(p,arcname=p.relative_to(PROJECT).as_posix(),recursive=False)
            digest=hashlib.sha256(archive.read_bytes()).hexdigest()
            receipt={'deploymentId':'showcase-20261008','archiveSha256':digest,'files':len(files),'bytes':archive.stat().st_size}
            (OUTPUT/'deployment.json').write_text(json.dumps(receipt,indent=2))
            for name,client in clients.items():
                root=remote(client,"from pathlib import Path\nr=Path.home()/'axnetcc-showcase-20261008';r.mkdir(exist_ok=True);print(r)").strip()
                sftp=client.open_sftp();sftp.put(str(archive),root+'/release.tar.gz');sftp.close()
                code=f"""from pathlib import Path
import tarfile,hashlib
r=Path.home()/'axnetcc-showcase-20261008';p=r/'release.tar.gz'
assert hashlib.sha256(p.read_bytes()).hexdigest()=={digest!r}
target=r/'release'
if target.exists():raise RuntimeError('Release exists; do not overwrite running deployment')
target.mkdir()
with tarfile.open(p) as bundle:
 for member in bundle.getmembers():
  resolved=(target/member.name).resolve()
  if not resolved.is_relative_to(target.resolve()) or not member.isfile():raise RuntimeError('Unsafe archive member')
 bundle.extractall(target,filter='data')
print('release-verified')
"""
                transport.emit({'host':name,'extract':remote(client,code).strip()})
            for name in ['mnckoren','ai-cloud','hpc']:
                result=remote(clients[name],(PROJECT/'scripts/start-showcase-node.py').read_text(encoding='utf8'))
                transport.emit({'host':name,'startup':json.loads(result)})
            # Reverse forwarding uses a password only in memory; no private key copied to HPC.
            hpcKey=clients['hpc'].get_transport().get_remote_server_key()
            known=f'10.246.246.44 {hpcKey.get_name()} {hpcKey.get_base64()}\n'
            reverse="""import os,json,subprocess,time
from pathlib import Path
r=Path.home()/'axnetcc-showcase-20261008';shared=r/'shared'
known=shared/'hpc-known-hosts';known.write_text(KNOWN);known.chmod(0o600)
ask=shared/'askpass.py';ask.write_text('#!/usr/bin/env python3\\nimport os\\nprint(os.environ["SHOWCASE_SSH_PASSWORD"])\\n');ask.chmod(0o700)
env=os.environ.copy();env.update({'SSH_ASKPASS':str(ask),'SSH_ASKPASS_REQUIRE':'force','DISPLAY':':showcase','SHOWCASE_SSH_PASSWORD':PASSWORD})
argv=['ssh','-N','-o','BatchMode=no','-o','NumberOfPasswordPrompts=1','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+str(known),'-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=20']
for i in range(8):argv+=['-R',f'127.0.0.1:{26101+i}:127.0.0.1:{6101+i}']
argv+=['lim921211@10.246.246.44']
with (r/'logs/reverse-ssh.log').open('ab') as log:p=subprocess.Popen(argv,stdin=subprocess.DEVNULL,stdout=log,stderr=log,env=env,start_new_session=True,cwd=r/'release')
(shared/'reverse-ssh-process.json').write_text(json.dumps({'pid':p.pid,'ownedRoot':str(r),'args':argv}))
env.pop('SHOWCASE_SSH_PASSWORD',None);time.sleep(3)
if p.poll() is not None:raise RuntimeError('Reverse SSH connection failed; inspect dedicated transport log')
print(json.dumps({'reverseSshPid':p.pid,'dataPath':'ai-cloud-to-HPC-direct'}))
"""
            result=remote(clients['ai-cloud'],'KNOWN='+repr(known)+'\nPASSWORD='+repr(secrets['hpc'])+'\n'+reverse)
            transport.emit(json.loads(result));secrets.clear()
            transport.emit(receipt)
            return
        secrets.clear()
        if args.action=='recover':
            handled=set()
            while clients['hpc'].get_transport().is_active():
                raw=remote(clients['hpc'],"from pathlib import Path\np=Path.home()/'axnetcc-showcase-20261008/shared/reset-request.json'\nprint(p.read_text() if p.exists() else '{}')")
                request=json.loads(raw)
                if request.get('id') and request['id'] not in handled:
                    receipts={}
                    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
                        futures={name:pool.submit(remote,client,(PROJECT/'scripts/reset-showcase-model.py').read_text(encoding='utf8')) for name,client in clients.items()}
                        for name,future in futures.items():receipts[name]=json.loads(future.result())
                    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
                        futures={name:pool.submit(remote,client,(PROJECT/'scripts/warm-showcase-model.py').read_text(encoding='utf8'),150) for name,client in clients.items()}
                        for name,future in futures.items():receipts[name]['warmup']=json.loads(future.result())
                    packet=json.dumps({'id':request['id'],'completedAt':int(time.time()*1000),'receipts':receipts})
                    remote(clients['hpc'],"from pathlib import Path\np=Path.home()/'axnetcc-showcase-20261008/shared/reset-receipt.json'\np.write_text("+repr(packet)+")")
                    handled.add(request['id']);transport.emit(json.loads(packet))
                time.sleep(2)
            return
        if args.action=='sync-monitor':
            client=clients['hpc'];sftp=client.open_sftp()
            remoteRoot=remote(client,"from pathlib import Path;print(Path.home()/'axnetcc-showcase-20261008/release')").strip()
            for folder in ['monitor','scripts']:
                for p in (PROJECT/folder).rglob('*'):
                    if p.is_file() and p.suffix in ['.mjs','.js','.css','.html','.py'] and '__pycache__' not in p.parts:
                        sftp.put(str(p),remoteRoot+'/'+p.relative_to(PROJECT).as_posix())
            sftp.close();transport.emit({'monitorAssetsSynced':True});return
        if args.action=='pull':
            for name,client in clients.items():
                sftp=client.open_sftp()
                root=remote(client,"from pathlib import Path;print(Path.home()/'axnetcc-showcase-20261008')").strip()
                local=OUTPUT/name;local.mkdir(exist_ok=True)
                for folder in ['shared','logs']:
                    for item in sftp.listdir(root+'/'+folder):
                        if item in ['campaign.json','campaign-observed.json','samples.jsonl','manifest.json','execution-logs.json','resets.jsonl','network-final.json'] or (item.startswith('RUN-') and item.endswith('.json')) or item.endswith('.log'):
                            sftp.get(root+'/'+folder+'/'+item,str(local/item))
                sftp.close()
            transport.emit({'pulledTo':str(OUTPUT)})
            return
        class Forward(socketserver.BaseRequestHandler):
            def handle(self):
                channel=None
                try:
                    channel=clients['hpc'].get_transport().open_channel('direct-tcpip',('127.0.0.1',self.server.server_address[1]),self.request.getpeername(),timeout=8)
                    while True:
                        ready,_,_=select.select([self.request,channel],[],[],30)
                        for source in ready:
                            data=source.recv(65536)
                            if not data:return
                            (channel if source is self.request else self.request).sendall(data)
                except Exception:pass
                finally:
                    if channel:channel.close()
        class Server(socketserver.ThreadingTCPServer):
            allow_reuse_address=True;daemon_threads=True
        for port in [36100,36200]:
            server=Server(('127.0.0.1',port),Forward);servers.append(server)
            threading.Thread(target=server.serve_forever,daemon=True).start()
        transport.emit({'urls':['http://127.0.0.1:36100','http://127.0.0.1:36200/distributed'],'dataPathUsesPC':False})
        logScript="""import json
from pathlib import Path
r=Path.home()/'axnetcc-showcase-20261008';rows=[]
for p in (r/'logs').glob('*.log'):
 with p.open(errors='replace') as f:
  f.seek(max(0,p.stat().st_size-131072))
  for line in f:
   try:v=json.loads(line)
   except ValueError:continue
   if isinstance(v,dict) and v.get('schema')=='execution-log/v1':rows.append(v)
print(json.dumps(rows[-1500:]))
"""
        previous=set()
        while clients['hpc'].get_transport().is_active():
            events=[]
            for name,client in clients.items():
                for row in json.loads(remote(client,logScript)):
                    row['host']=name;events.append(row)
                    identity=json.dumps(row,sort_keys=True)
                    if identity not in previous:transport.emit(row)
            previous={json.dumps(row,sort_keys=True) for row in events}
            packet=json.dumps({'updatedAt':int(time.time()*1000),'events':events[-5000:]})
            sftp=clients['hpc'].open_sftp()
            root=remote(clients['hpc'],"from pathlib import Path;print(Path.home()/'axnetcc-showcase-20261008/shared')").strip()
            with sftp.open(root+'/execution-logs.json.tmp','w') as f:f.write(packet)
            sftp.posix_rename(root+'/execution-logs.json.tmp',root+'/execution-logs.json');sftp.close()
            time.sleep(2)
    finally:
        secrets.clear()
        for server in servers:server.shutdown();server.server_close()
        for client in clients.values():client.close()

if __name__=='__main__':main()
