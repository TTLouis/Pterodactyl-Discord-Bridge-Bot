import assert from "node:assert/strict";
import test from "node:test";
import {orderEditorIncrement,orderEditorRows,parseOrderEditor} from "../src/platforms/discord/server-order-editor.js";
const rows=orderEditorRows([{pterodactylServerId:"a",name:"Alpha"},{pterodactylServerId:"b",name:"Beta",archived:true}]);
test("popup ranks servers by numbers while retaining archived entries",()=>assert.deepEqual(parseOrderEditor(rows,"Alpha | 2\nBeta [archived] | 1"),["b","a"]));
for(const text of ["Alpha | 1", "Changed | 1\nBeta [archived] | 2"])test(`popup rejects invalid ordering: ${text}`,()=>assert.throws(()=>parseOrderEditor(rows,text)));

test("popup accepts sparse positions and returns the saved sequence and reopens with gaps",()=>{
  const order=parseOrderEditor(rows,"Alpha | 9000\nBeta [archived] | 20");
  assert.deepEqual(order,["b","a"]);
  const normalized=orderEditorRows(order.map(id=>({pterodactylServerId:id,name:id})));
  assert.deepEqual(normalized.map(row=>row.number),[10,20]);
});
test("popup compares arbitrarily large positions without rounding or overflow",()=>{
  const lower="9".repeat(350), higher="1"+"0".repeat(350);
  assert.deepEqual(parseOrderEditor(rows,`Alpha | ${higher}\nBeta [archived] | ${lower}`),["b","a"]);
  assert.deepEqual(parseOrderEditor(rows,"Alpha | 9007199254740993\nBeta [archived] | 9007199254740992"),["b","a"]);
});
test("equal positions keep the existing server order",()=>assert.deepEqual(parseOrderEditor(rows,"Alpha | 50\nBeta [archived] | 50"),["a","b"]));
for(const rank of ["1.5","1e20","Infinity",""])test(`popup rejects a noninteger position: ${rank}`,()=>assert.throws(()=>parseOrderEditor(rows,`Alpha | ${rank}\nBeta [archived] | 2`)));

test("negative and zero positions sort numerically before positive positions",()=>{
  const three=orderEditorRows([{pterodactylServerId:"a",name:"Alpha"},{pterodactylServerId:"b",name:"Beta",archived:true},{pterodactylServerId:"c",name:"Gamma"}]);
  assert.deepEqual(parseOrderEditor(three,"Alpha | 9000\nBeta [archived] | -20\nGamma | 0"),["b","c","a"]);
});
test("large negative positions, explicit plus signs and leading zeroes are exact",()=>{
  assert.deepEqual(parseOrderEditor(rows,`Alpha | -${"9".repeat(350)}\nBeta [archived] | -${"1".repeat(350)}`),["a","b"]);
  assert.deepEqual(parseOrderEditor(rows,"Alpha | +00020\nBeta [archived] | -0001"),["b","a"]);
});

for (const [count, expected] of [[0,10],[1,10],[8,10],[11,10],[54,10],[55,100],[100,100],[549,100],[550,1000]]) {
  test(`popup count ${count} chooses nearest power-of-ten gap ${expected}`,()=>assert.equal(orderEditorIncrement(count),expected));
}
test("eleven servers reopen with gaps and preserve their saved order",()=>{
  const servers=Array.from({length:11},(_,index)=>({pterodactylServerId:String(index),name:`Server ${index}`}));
  const displayed=orderEditorRows(servers);assert.deepEqual(displayed.map(row=>row.number),Array.from({length:11},(_,index)=>(index+1)*10));
  assert.deepEqual(parseOrderEditor(displayed,displayed.map(row=>`${row.label} | ${row.number}`).join("\n")),servers.map(server=>server.pterodactylServerId));
});
