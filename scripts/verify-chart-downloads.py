"""Verify exported chart bytes through the running monitor browser."""
import importlib.util,json
from pathlib import Path
root=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('finalizer',root/'scripts/finalize-local-24h.py')
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)
b=f.Browser();b.navigate('http://127.0.0.1:3200/evaluation')
result=b.js('''(async()=>{
 const picker=document.querySelector('#evaluation-source');picker.value='longitudinal';picker.dispatchEvent(new Event('change',{bubbles:true}));
 if(document.querySelectorAll('.paperFigure').length!==8)throw new Error('Expected eight graphs');
 const exports=[];const blobs=new Map();const originalUrl=URL.createObjectURL;URL.createObjectURL=function(blob){const url=originalUrl.call(URL,blob);blobs.set(url,blob);return url;};
 const errors=[];const oldError=console.error;console.error=(...args)=>errors.push(args.map(v=>String(v)));
 const original=HTMLAnchorElement.prototype.click;
 HTMLAnchorElement.prototype.click=function(){exports.push({url:this.href,name:this.download});};
 try {
  const buttons=document.querySelectorAll('.paperFigure:first-child [data-chart-export]');
  for(const button of buttons){button.click();for(let i=0;i<100&&button.disabled;i++)await new Promise(resolve=>setTimeout(resolve,50));if(button.disabled)throw new Error('Export timed out');}
  if(exports.length!==2)throw new Error('Expected two downloads: '+JSON.stringify({buttons:buttons.length,exports,errors}));
  const svg=await blobs.get(exports[0].url).text();
  const doc=new DOMParser().parseFromString(svg,'image/svg+xml');
  if(doc.querySelector('parsererror')||!svg.includes('E2E Latency')||!svg.includes('executions')||!svg.includes('font-family'))throw new Error('Invalid standalone SVG');
  const png=blobs.get(exports[1].url);const bitmap=await createImageBitmap(png);
  if(bitmap.width!==2700||bitmap.height!==1230)throw new Error('Invalid PNG dimensions');
  return {graphs:8,svg:exports[0].name,png:exports[1].name,width:bitmap.width,height:bitmap.height,bytes:png.size};
 }finally{HTMLAnchorElement.prototype.click=original;console.error=oldError;URL.createObjectURL=originalUrl;}
})()''')
(root/'outputs/video-production/chart-download-verification.json').write_text(json.dumps(result,indent=2),encoding='utf8')
print(json.dumps(result))
