import json
from pathlib import Path
import socket
import urllib.request
root=Path.home()/'axnetcc-showcase-20261008'
rows={}
for port in [36100,36101,36200]:
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}'+('/api/health' if port!=36200 else '/api/network'),timeout=5) as response:
            value=json.load(response)
        rows[str(port)]={'http':200,'keys':list(value),'scheduler':value.get('scheduler'),'targets':value.get('targets')}
    except Exception as error:rows[str(port)]={'errorType':type(error).__name__}
for port in [26101,26201]:
    try:
        connection=socket.create_connection(('127.0.0.1',port),2);connection.close();rows[str(port)]={'connected':True}
    except OSError:rows[str(port)]={'connected':False}
print(json.dumps(rows))
if (root/'logs/reverse-ssh.log').exists():
    print(json.dumps({'reverseTransportLog':(root/'logs/reverse-ssh.log').read_text(errors='replace')[-2000:]}))
