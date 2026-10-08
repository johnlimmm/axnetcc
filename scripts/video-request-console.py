"""Display the recorder's real API actions; no simulated progress."""
from pathlib import Path
import time
path=Path(__file__).resolve().parents[1]/'outputs/video-production/actions.log'
print('AXNetCC | REQUEST EXECUTION CONSOLE\nLocal -> distributed -> backup -> measured comparison\nActual API actions and terminal results only.\n',flush=True)
while not path.exists():time.sleep(.2)
with path.open(encoding='utf8') as stream:
    while True:
        line=stream.readline()
        if line: print(line.rstrip(),flush=True)
        else: time.sleep(.2)
