"""Trusted SSH access to the existing isolated demo; secrets stay in memory.

Default actions are status, sanitized execution logs and localhost UI forwarding.
Use --credential-session only with a user-authorized prior session file.
"""
import argparse
import concurrent.futures
import getpass
import json
from pathlib import Path
import re
import select
import socketserver
import sys
import threading
import time

PROJECT = Path(__file__).resolve().parents[1]
TRANSPORT = PROJECT / 'outputs/distributed-deployment'
sys.path.insert(0, str(TRANSPORT / 'python'))
import paramiko

def saved_passwords(path):
    found = {}
    for line in Path(path).open(encoding='utf8'):
        try:
            payload = json.loads(line).get('payload', {})
        except ValueError:
            continue
        if payload.get('type') != 'message' or payload.get('role') != 'user':
            continue
        text = '\n'.join(c.get('text', '') for c in payload.get('content', []))
        if len(text) > 1000:
            continue
        for name, marker in [('hpc', 'HPC-VM'), ('hub', 'mnckoren')]:
            if marker in text:
                match = re.search(r'PW[^\s]*\s+([^\s]+)', text)
                if match:
                    found[name] = match.group(1).strip('`')
    return found

def new_client():
    client = paramiko.SSHClient()
    client.load_host_keys(str(TRANSPORT / 'known_hosts'))
    # Port migration: trust only the exact key already verified on the old port.
    prior = client.get_host_keys().lookup('[116.89.177.90]:32764')
    if prior and not client.get_host_keys().lookup('[116.89.177.90]:31055'):
        for kind, key in prior.items():
            client.get_host_keys().add('[116.89.177.90]:31055', kind, key)
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    return client

def emit(value):
    print(json.dumps(value, ensure_ascii=True), flush=True)

def connect(host, port, user, **options):
    client = new_client()
    try:
        client.connect(hostname=host, port=port, username=user, look_for_keys=False,
                       allow_agent=False, timeout=8, auth_timeout=10, banner_timeout=10, **options)
        client.get_transport().set_keepalive(20)
        return client
    except Exception:
        client.close()
        raise

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['status', 'inspect', 'logs', 'tunnel', 'run'])
    parser.add_argument('--credential-session')
    parser.add_argument('--script', help='Local reviewed Python script to execute over SSH stdin')
    parser.add_argument('--hosts', default='hpc', help='Comma-separated connected node names')
    args = parser.parse_args()
    secrets = saved_passwords(args.credential_session) if args.credential_session else {}
    if 'hpc' not in secrets:
        secrets['hpc'] = getpass.getpass('HPC password: ')
    clients = {}
    try:
        clients['hpc'] = connect('10.246.246.44', 22, 'lim921211', password=secrets.pop('hpc'))
        emit({'host': 'hpc', 'sshAuthenticated': True})
        def child(name, host, port, user, options):
            try:
                channel = clients['hpc'].get_transport().open_channel('direct-tcpip', (host, port), ('127.0.0.1', 0), timeout=8)
                try:
                    clients[name] = connect(host, port, user, sock=channel, **options)
                except Exception:
                    channel.close()
                    raise
                emit({'host': name, 'sshAuthenticated': True, 'via': 'hpc'})
            except Exception as error:
                emit({'host': name, 'sshAuthenticated': False, 'errorType': type(error).__name__})
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(child, 'ai-cloud', '116.89.177.90', 31055, 'jovyan',
                                   {'key_filename': str(Path.home() / 'Downloads/private.pem')})]
            if secrets.get('hub'):
                futures.append(pool.submit(child, 'mnckoren', '210.114.95.58', 22, 'mnckoren', {'password': secrets['hub']}))
            for future in futures:
                future.result()
        secrets.clear()
        if args.action == 'run':
            script = Path(args.script).resolve() if args.script else None
            if not script or not script.is_relative_to(PROJECT / 'scripts') or script.suffix != '.py':
                raise ValueError('Script must be a project scripts Python file')
            for name in args.hosts.split(','):
                if name not in clients:
                    raise ValueError('Requested node is not connected')
                stdin, out, err = clients[name].exec_command('python3 -', timeout=3600)
                stdin.write(script.read_text(encoding='utf8')); stdin.flush(); stdin.channel.shutdown_write()
                with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                    errors = pool.submit(err.read)
                    for line in out:
                        emit({'host': name, 'line': line.rstrip('\n')})
                    failure = errors.result().decode('utf8', 'replace')
                emit({'host': name, 'stderr': failure, 'exitCode': out.channel.recv_exit_status()})
            return
        # Restrict inspection to this demo-owned directory; no environment/config dump.
        for name, client in clients.items():
            command = "python3 - <<'PY'\nimport json,socket\nfrom pathlib import Path\nr=Path.home()/'axnetcc-demo-20260923'\nprint(json.dumps({'hostname':socket.gethostname(),'demoRootExists':r.is_dir(),'releaseExists':(r/'release').is_dir()}))\nPY"
            _, out, _ = client.exec_command(command, timeout=15)
            emit({'host': name, 'status': json.loads(out.read(4096))})
        if args.action == 'status':
            return
        if args.action == 'inspect':
            command = """python3 - <<'PY'
import json,socket,urllib.request
from pathlib import Path
r=Path.home()/'axnetcc-demo-20260923'
allowed=['DEMO_PROFILE','DEMO_DEPLOYMENT_ID','DEMO_CORE_NODE_ID','EDGE_NODE_ID','EDGE_REPLICA_ID','EDGE_AGENT_ID','EDGE_AGENT_MODE','PORT','MONITOR_PORT','LOCAL_LLM_MODEL','LOCAL_LLM_SYNTHESIS_MODEL']
configs=[]
for p in (r/'shared/config').glob('*.json'):
 try:
  v=json.loads(p.read_text()); configs.append({'name':p.name,'values':{k:v[k] for k in allowed if k in v},'keys':[k for k in v if 'TOKEN' not in k and 'SECRET' not in k and 'PASSWORD' not in k]})
 except Exception:pass
ports={}
for port in [35100,35101,35102,35200,13434,13435,19443,19444,25199,25101,25201,5101,5201]:
 s=socket.socket();s.settimeout(.2);ports[str(port)]=s.connect_ex(('127.0.0.1',port))==0;s.close()
files=[str(p.relative_to(r)) for folder in ['shared','logs'] for p in (r/folder).glob('*') if p.is_file() and not p.name.endswith('.json')]
print(json.dumps({'configs':configs,'listening':ports,'logFiles':files}))
PY"""
            for name, client in clients.items():
                _, out, _ = client.exec_command(command, timeout=20)
                emit({'host': name, 'inspection': json.loads(out.read(1048576))})
            return
        if args.action == 'logs':
            command = "python3 - <<'PY'\nimport json\nfrom pathlib import Path\nr=Path.home()/'axnetcc-demo-20260923'\nkeys=['schema','timestamp','event','requestId','agentId','attemptId','nodeId','replicaId','status','elapsedMs']\npaths=list((r/'shared').glob('*.log'))+list((r/'logs').glob('*.log'))\nfor p in paths[:32]:\n with p.open(errors='replace') as f:\n  f.seek(max(0,p.stat().st_size-131072))\n  for line in f:\n   try:v=json.loads(line)\n   except ValueError:continue\n   if isinstance(v,dict) and v.get('schema')=='execution-log/v1':print(json.dumps({k:v.get(k) for k in keys}))\nPY"
            for name, client in clients.items():
                _, out, _ = client.exec_command(command, timeout=15)
                rows = [json.loads(line) for line in out.read(1048576).decode().splitlines()]
                emit({'host': name, 'executionLogs': rows, 'note': 'empty means no recorded structured logs; no reconstructed node logs'})
            return
        transport = clients['hpc'].get_transport()
        class Forward(socketserver.BaseRequestHandler):
            def handle(self):
                channel = None
                try:
                    channel = transport.open_channel('direct-tcpip', ('127.0.0.1', self.server.server_address[1]), self.request.getpeername(), timeout=8)
                    while True:
                        ready, _, _ = select.select([self.request, channel], [], [], 30)
                        for source in ready:
                            data = source.recv(65536)
                            if not data:
                                return
                            (channel if source is self.request else self.request).sendall(data)
                except Exception:
                    pass
                finally:
                    if channel:
                        channel.close()
        class Server(socketserver.ThreadingTCPServer):
            allow_reuse_address = True
            daemon_threads = True
        servers = []
        try:
            for port in [35100, 35200]:
                server = Server(('127.0.0.1', port), Forward)
                servers.append(server)
                threading.Thread(target=server.serve_forever, daemon=True).start()
            emit({'remoteControl': 'ssh-authenticated', 'browserUrls': ['http://127.0.0.1:35100', 'http://127.0.0.1:35200/distributed'], 'bind': 'localhost-only'})
            while transport.is_active():
                time.sleep(1)
        finally:
            for server in servers:
                server.shutdown()
                server.server_close()
    except Exception as error:
        emit({'errorType': type(error).__name__, 'ready': False})
        sys.exit(1)
    finally:
        secrets.clear()
        for client in clients.values():
            client.close()

if __name__ == '__main__':
    main()
