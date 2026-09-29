// Jest-only workaround: @nestjs/throttler is CommonJS and require()s @nestjs/common,
// which is ESM in Nest 12. Jest's ESM loader refuses that require() while
// @nestjs/common is still being linked ("require(esm) in a cycle"). Loading the
// Nest packages here, in a setup file that runs before any test module graph is
// linked, avoids it. Plain Node (npm run start:prod) needs none of this.
import '@nestjs/common';
import '@nestjs/core';
