import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCampaign, summarizeCampaign } from '../monitor/campaign.mjs';
import { readExecutionLogs } from '../monitor/execution-logs.mjs';

test('comparison retains failed samples in denominator and exposes per-metric missing coverage', () => {
  const rows=[{method:'proposed',scenario:'healthy',status:'completed',realInference:true,elapsedMs:100,ttftMs:0,tpotMs:2},
    {method:'proposed',scenario:'healthy',status:'failed',realInference:false,elapsedMs:900,ttftMs:null,tpotMs:null}];
  const [group]=summarizeCampaign(rows);
  assert.equal(group.count,2);assert.equal(group.successCount,1);assert.equal(group.p95Ms,900);
  assert.equal(group.ttftMs,0);assert.equal(group.coverage.ttftMs,1);assert.equal(group.tokensPerSecond,null);
});

test('artifact APIs strip raw queries/config and reject malformed or missing inputs', () => {
  const dir=mkdtempSync(join(tmpdir(),'showcase-contract-'));
  try {
    const file=join(dir,'campaign.json');
    writeFileSync(file,JSON.stringify({schema:'distributed-showcase/v1',state:'partial',faultRestored:true,
      manifest:{deploymentId:'showcase',startedAt:'2026-10-08T00:00:00Z',plannedCount:38,secret:'SECRET'},
      samples:[{method:'proposed',scenario:'healthy',status:'failed',requestId:'RUN-123',query:'SECRET',elapsedMs:NaN,realInference:false}]}));
    const result=readCampaign(file);
    assert.equal(result.manifest.state,'partial');assert.equal(result.manifest.sampleCount,1);assert.equal(result.manifest.plannedCount,38);
    assert.equal(result.samples[0].elapsedMs,null);assert.ok(!JSON.stringify(result).includes('SECRET'));
    writeFileSync(file,'{}');assert.equal(readCampaign(file).status,'invalid');assert.equal(readCampaign().status,'missing');
    const logs=join(dir,'logs.json');
    writeFileSync(logs,JSON.stringify({updatedAt:1,events:[{schema:'execution-log/v1',host:'hpc',event:'edge-completed',requestId:'RUN-123',timestamp:'2026-10-08T00:00:00.000Z',prompt:'SECRET',elapsedMs:3},{schema:'execution-log/v1',event:'SECRET'}]}));
    const projected=readExecutionLogs(logs);
    assert.equal(projected.events.length,1);assert.equal(projected.events[0].host,'hpc');assert.ok(!JSON.stringify(projected).includes('SECRET'));
    assert.equal(readExecutionLogs().status,'missing');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
