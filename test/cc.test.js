"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { cleanLine, cleanCcLine, cleanText } = require("../src/cleaner");

test("strips card line with bank and name extras to number|mm|yy|cvv", () => {
    assert.equal(
        cleanLine("4111111111111111|08|27|123|XX/IN| [VISA/CREDIT/NA] {BANK OF BARODA}| Harsha Jethani"),
        "4111111111111111|08|27|123"
    );
});

test("card line tolerates spaces, 1-digit month and 4-digit year", () => {
    assert.equal(cleanLine("4111111111111111 | 8 | 2027 | 123 | extra"), "4111111111111111|08|27|123");
    assert.equal(cleanCcLine("4111 1111 1111 1111|3|27|1234|XX/IN|NA|Name"), "4111111111111111|03|27|1234");
});

test("card cleaner rejects bad month and short cvv", () => {
    assert.equal(cleanCcLine("4111111111111111|13|27|123"), null);
    assert.equal(cleanCcLine("4111111111111111|08|27|12"), null);
});

test("non-card lines still use the normal cleaner", () => {
    assert.equal(cleanLine("user@example.com:pass123"), "user@example.com:pass123");
    assert.equal(cleanLine("https://site.com:443"), null);
});
