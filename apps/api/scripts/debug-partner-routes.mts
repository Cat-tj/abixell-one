import { buildApp } from "../src/app.js";
const app = buildApp();
await app.ready();
console.log("READY OK");
await app.close();
