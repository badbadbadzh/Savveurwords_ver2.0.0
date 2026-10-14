'use strict';
// Parse only a literal object/array tree, never execute third-party JavaScript.
function literal(source,bindings=Object.create(null)){
 let i=0,count=0;function space(){while(/\s/.test(source[i]||'!'))i++}
 function value(depth=0){space();if(depth>100||++count>150000)throw Error('State too large');const ch=source[i];
  if(ch==='"'){const start=i++;while(i<source.length){if(source[i]==='\\'){i+=2;continue}if(source[i++]==='"')return JSON.parse(source.slice(start,i))}throw Error('String')}
  if(ch==='{'||ch==='['){i++;const arr=ch==='[',out=arr?[]:Object.create(null),end=arr?']':'}';space();if(source[i]===end){i++;return out}while(i<source.length){
    let key;if(!arr){space();if(source[i]==='"')key=value(depth+1);else{const m=source.slice(i).match(/^[\w$]+/);if(!m)throw Error('Key');key=m[0];i+=key.length}space();if(source[i++]!==':')throw Error('Colon')}
    const v=value(depth+1);if(arr)out.push(v);else out[key]=v;space();if(source[i]===end){i++;return out}if(source[i++]!==',')throw Error('Comma');
   }throw Error('Container')}
  const empty=source.slice(i).match(/^void\s+0\b/);if(empty){i+=empty[0].length;return undefined}
  const n=source.slice(i).match(/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/i);if(n){i+=n[0].length;return Number(n[0])}
  const id=source.slice(i).match(/^[A-Za-z_$][\w$]*/)?.[0];if(!id)throw Error('Value');i+=id.length;
  if(id==='true')return true;if(id==='false')return false;if(id==='null')return null;if(id==='undefined')return undefined;if(Object.hasOwn(bindings,id))return bindings[id];throw Error('Unknown value');
 }
 const result=value();space();if(i!==source.length)throw Error('Trailing code');return result;
}
function readState(html){
 const raw=html.match(/window\.__pinia=([\s\S]*?)<\/script>/)?.[1]?.trim().replace(/;$/,'');if(!raw)return null;
 const m=raw.match(/^\(function\(([^)]*)\)\{return ([\s\S]*)\}\(([\s\S]*)\)\)$/);if(!m)return null;
 const args=literal('['+m[3]+']'),names=m[1].split(','),bindings=Object.create(null);names.forEach((name,index)=>{if(!/^[\w$]+$/.test(name))throw Error('Argument');bindings[name]=args[index]});return literal(m[2],bindings);
}
module.exports={readState,literal};
