import test from "node:test";
import assert from "node:assert/strict";
import {sanitizeSourceMetadata,mergeSourceMetadata} from "../src/source-metadata.mjs";
test("ratings remain source-provided numbers on the verified five-point scale", () => {
  for(const rating of [0,3.7,5])assert.equal(sanitizeSourceMetadata({rating}).rating,rating);
  for(const rating of [null,"4.8",-1,5.1,NaN,Infinity])assert.equal(sanitizeSourceMetadata({rating}).rating,null);
  assert.equal(Object.hasOwn(sanitizeSourceMetadata({}),"rating"),false);
});
test("sparse detail metadata preserves listing ratings but an explicitly unknown rating clears it", () => {
  assert.equal(mergeSourceMetadata({rating:4.8},{title:"새 작품 제목"}).rating,4.8);
  assert.equal(mergeSourceMetadata({rating:4.8},{rating:3.2}).rating,3.2);
  assert.equal(mergeSourceMetadata({rating:4.8},{rating:null}).rating,null);
});
