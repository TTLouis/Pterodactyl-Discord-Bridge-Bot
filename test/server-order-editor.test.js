import assert from "node:assert/strict";
import test from "node:test";
import {orderEditorRows,parseOrderEditor} from "../src/platforms/discord/server-order-editor.js";
const rows=orderEditorRows([{pterodactylServerId:"a",name:"Alpha"},{pterodactylServerId:"b",name:"Beta",archived:true}]);
test("popup ranks servers by numbers while retaining archived entries",()=>assert.deepEqual(parseOrderEditor(rows,"Alpha | 2\nBeta [archived] | 1"),["b","a"]));
for(const text of ["Alpha | 1", "Alpha | 1\nBeta [archived] | 1", "Alpha | 1\nBeta [archived] | 3", "Changed | 1\nBeta [archived] | 2", "Alpha | -1\nBeta [archived] | 2"])test(`popup rejects invalid ordering: ${text}`,()=>assert.throws(()=>parseOrderEditor(rows,text)));
