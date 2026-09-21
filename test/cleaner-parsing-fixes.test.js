"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
    cleanLine,
    cleanText,
    cleanLinesArray,
    stripLabelPrefixes,
    extractFromKeyValueLabels,
    stripTrailingMetadata,
} = require("../src/cleaner");

test("cleaner fixes: strips action: and similar form/URL label prefixes", () => {
    assert.equal(cleanLine("action:user:pass"), "user:pass");
    assert.equal(cleanLine("form_action:user:pass"), "user:pass");
    assert.equal(cleanLine("action:https://site.com/login:user:pass"), "user:pass");
    assert.equal(
        cleanLine("action:https://site.com/login:user:pass", { keepUrl: true }),
        "https://site.com/login:user:pass",
    );
    assert.equal(cleanLine("login:user:pass"), "user:pass");
    assert.equal(cleanLine("user:admin:pass"), "admin:pass");
    assert.equal(cleanLine("url:user@domain.com:pass"), "user@domain.com:pass");
});

test("cleaner fixes: cleans user:login pass and space-separated credentials after user labels", () => {
    assert.equal(cleanLine("user:login pass"), "login:pass");
    assert.equal(cleanLine("user: admin 123456"), "admin:123456");
    assert.equal(cleanLine("username: john mysecret"), "john:mysecret");
    assert.equal(cleanLine("login: test@domain.com pass999"), "test@domain.com:pass999");
    assert.equal(cleanLine("account: alice pass_word"), "alice:pass_word");
});

test("cleaner fixes: extracts single-line key-value stealer labels (USER: ... PASS: ...)", () => {
    assert.equal(cleanLine("USER: foo PASS: bar"), "foo:bar");
    assert.equal(cleanLine("user: john pass: mypass"), "john:mypass");
    assert.equal(cleanLine("user:john:pass:secret"), "john:secret");
    assert.equal(cleanLine("Username: victim@gmail.com Password: SuperPassword123"), "victim@gmail.com:SuperPassword123");
    assert.equal(cleanLine("Host: site.com | User: test@gmail.com | Pass: 123456"), "test@gmail.com:123456");
    assert.equal(
        cleanLine("URL: https://site.com USER: admin PASS: secret"),
        "admin:secret",
    );
    assert.equal(
        cleanLine("URL: https://site.com USER: admin PASS: secret", { keepUrl: true }),
        "https://site.com:admin:secret",
    );
});

test("cleaner fixes: strips trailing stealer metadata and browser tags from password", () => {
    assert.equal(
        cleanLine("user@example.com:password | IP: 1.2.3.4"),
        "user@example.com:password",
    );
    assert.equal(
        cleanLine("user@example.com:password [Google Chrome]"),
        "user@example.com:password",
    );
    assert.equal(
        cleanLine("user@example.com:password | Country: US | Soft: Chrome"),
        "user@example.com:password",
    );
    assert.equal(cleanLine("user:pass123;"), "user:pass123");
});

test("cleaner fixes: drops orphan stealer metadata lines and preserves valid single-pair combos", () => {
    // Orphan metadata lines should be rejected (returns null)
    assert.equal(cleanLine("Password: secret123"), null);
    assert.equal(cleanLine("Pass: 123456"), null);
    assert.equal(cleanLine("URL: https://accounts.google.com/"), null);
    assert.equal(cleanLine("Soft: Chrome"), null);
    assert.equal(cleanLine("Application: Mozilla Firefox"), null);

    // Legitimate account named "user" with password
    assert.equal(cleanLine("user:secret123"), "user:secret123");
    assert.equal(cleanLine("admin:admin123"), "admin:admin123");
});

test("cleaner fixes: cleanText parses multi-line stealer log blocks", () => {
    const dump = [
        "==================================================",
        "Application: Google Chrome",
        "URL: https://accounts.google.com/",
        "Username: victim@gmail.com",
        "Password: SuperSecretPassword123!",
        "==================================================",
        "URL: https://github.com/login",
        "Username: octocat",
        "Password: OctoPassword456!",
        "==================================================",
        "action:user:pass",
        "user:login pass",
        "user@example.com:Passw0rd!",
    ].join("\n");

    const res = cleanText(dump, { keepUrl: false });
    assert.deepEqual(res.lines, [
        "victim@gmail.com:SuperSecretPassword123!",
        "octocat:OctoPassword456!",
        "user:pass",
        "login:pass",
        "user@example.com:Passw0rd!",
    ]);
    assert.equal(res.stats.kept, 5);
});
