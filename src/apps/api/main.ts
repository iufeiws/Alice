import { configureProcessOutboundHttpProxy } from "./bootstrap/outbound-http-runtime.js";

configureProcessOutboundHttpProxy();
await import("./bootstrap/api-runtime.js");
