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

test("cleaner fixes: strips LogLogonHandler, web handlers, and ensures user:pass without spaces", () => {
    // 1. LogLogonHandler in URL path or scheme prefix
    assert.equal(cleanLine("https://site.com/LogLogonHandler:admin:pass123"), "admin:pass123");
    assert.equal(cleanLine("https://site.com/admin/LogLogonHandler.aspx:admin:pass123"), "admin:pass123");
    assert.equal(cleanLine("http://corp.local/LogLogonHandler.ashx:admin:pass123"), "admin:pass123");
    assert.equal(cleanLine("LogLogonHandler:admin:pass123"), "admin:pass123");
    assert.equal(cleanLine("action:LogLogonHandler:admin:pass123"), "admin:pass123");
    assert.equal(cleanLine("LogonHandler:admin:pass123"), "admin:pass123");
    assert.equal(cleanLine("LoginHandler:admin:pass123"), "admin:pass123");

    // 2. Trailing spaces, system tags, and dates are completely stripped so credentials are strictly user:pass without spaces
    assert.equal(cleanLine("admin:pass123 extra stuff"), "admin:pass123");
    assert.equal(cleanLine("admin:pass123 [Windows 10]"), "admin:pass123");
    assert.equal(cleanLine("admin:pass123 (Chrome 120)"), "admin:pass123");
    assert.equal(cleanLine("admin:pass123 2026-09-21"), "admin:pass123");
    assert.equal(cleanLine("admin:pass123 2026-09-21 15:30:00"), "admin:pass123");
    assert.equal(cleanLine("admin:pass123 | IP: 1.2.3.4"), "admin:pass123");
    assert.equal(cleanLine("admin:pass123 ; status=active"), "admin:pass123");
    assert.equal(cleanLine("admin : pass123"), "admin:pass123");

    // 3. Combined LogLogonHandler + trailing spaces
    assert.equal(
        cleanLine("https://site.com/LogLogonHandler:admin:pass123 [Windows 11] 2026-09-21"),
        "admin:pass123"
    );
});

test("cleaner fixes: ultra-fast high-throughput filtering on large combolist batches", () => {
    const { cleanLinesArray } = require("../src/cleaner");
    const count = 50000;
    const lines = [];
    for (let i = 0; i < count; i++) {
        if (i % 3 === 0) lines.push(`user${i}@mail.com:pass${i}`);
        else if (i % 3 === 1) lines.push(`admin${i}:secret${i}`);
        else lines.push(`https://site.com/LogLogonHandler:victim${i}:pass${i} [Chrome]`);
    }

    const t0 = Date.now();
    const res = cleanLinesArray(lines);
    const duration = Date.now() - t0;

    assert.equal(res.stats.kept, count);
    assert.equal(res.lines.length, count);
    // 50,000 lines should be cleaned in under 500ms (allow up to 2000ms under heavy test runner load)
    assert.ok(duration < 2000, `Filtering took too long: ${duration}ms`);
});

test("cleaner fixes: strips unspaced pipe/semicolon/bracket stealer metadata tags", () => {
    assert.equal(cleanLine("user@example.com:secret|IP:1.2.3.4"), "user@example.com:secret");
    assert.equal(cleanLine("user@example.com:secret|IP: 1.2.3.4"), "user@example.com:secret");
    assert.equal(cleanLine("user@example.com:secret;status=active"), "user@example.com:secret");
    assert.equal(cleanLine("user@example.com:secret|Country:US"), "user@example.com:secret");
    assert.equal(cleanLine("user@example.com:secret|HWID:ABC123XYZ"), "user@example.com:secret");
    assert.equal(cleanLine("user@example.com:secret[Google Chrome]"), "user@example.com:secret");
    assert.equal(cleanLine("user@example.com:secret(Firefox)"), "user@example.com:secret");
    assert.equal(cleanLine("user@example.com:secret|Chrome"), "user@example.com:secret");
    assert.equal(cleanLine("user@example.com:secret|2026-09-22"), "user@example.com:secret");
    assert.equal(cleanLine("user@example.com:secret|url:https://target.com"), "user@example.com:secret");
});

test("cleaner fixes: unquotes wrapped lines, quoted tokens, JSON records, CSV commas, and SQL tuples", () => {
    // Wrapped lines
    assert.equal(cleanLine('"user@example.com:password123"'), "user@example.com:password123");
    assert.equal(cleanLine("'user@example.com:password123'"), "user@example.com:password123");

    // Individually quoted tokens
    assert.equal(cleanLine('"user@example.com":"password123"'), "user@example.com:password123");
    assert.equal(cleanLine("'user@example.com':'password123'"), "user@example.com:password123");
    assert.equal(cleanLine('"user@example.com"|"password123"'), "user@example.com:password123");

    // CSV format
    assert.equal(cleanLine('"user@example.com","password123"'), "user@example.com:password123");
    assert.equal(cleanLine("'user@example.com','password123'"), "user@example.com:password123");
    assert.equal(cleanLine("user@example.com,password123"), "user@example.com:password123");
    assert.equal(cleanLine("user@example.com,password123,US,2026-09-22"), "user@example.com:password123");

    // JSON objects / NDJSON
    assert.equal(cleanLine('{"email":"alice@example.com","password":"secret"}'), "alice@example.com:secret");
    assert.equal(cleanLine('{"username":"bob","password":"123"}'), "bob:123");
    assert.equal(cleanLine('{"user":"carol@site.com","pass":"p@ss","url":"https://site.com"}', { keepUrl: true }), "https://site.com:carol@site.com:p@ss");

    // SQL tuples
    assert.equal(cleanLine("('alice@example.com', 'secret')"), "alice@example.com:secret");
    assert.equal(cleanLine("('admin', 'secret123')"), "admin:secret123");

    // Key-value labels with quotes
    assert.equal(cleanLine('User: "alice@gmail.com" Pass: "secret"'), "alice@gmail.com:secret");
    assert.equal(cleanLine('"username": "alice@gmail.com", "password": "secret"'), "alice@gmail.com:secret");

    // Multi-line stealer record with quotes
    const multiLine = [
        'URL: "https://secure.example.com"',
        'Username: "dave@example.com"',
        'Password: "secretPassword123!"',
    ];
    const cleaned = cleanLinesArray(multiLine);
    assert.equal(cleaned.stats.kept, 1);
    assert.equal(cleaned.lines[0], "dave@example.com:secretPassword123!");
});

test("cleaner fixes: supports semicolons, multi-separators, SQL dumps, TSV, CSV with URLs, and rejects placeholders", () => {
    // Semicolons
    assert.equal(cleanLine("user@example.com;password123"), "user@example.com:password123");
    assert.equal(cleanLine("https://site.com;user@example.com;password123"), "user@example.com:password123");
    assert.equal(cleanLine("https://site.com;user@example.com;password123", { keepUrl: true }), "https://site.com:user@example.com:password123");
    assert.equal(cleanLine("site.com;admin;password123"), "admin:password123");
    assert.equal(cleanLine("admin;password123"), "admin:password123");

    // Multi-separators (repeated colons / pipes)
    assert.equal(cleanLine("user@example.com:::password123"), "user@example.com:password123");
    assert.equal(cleanLine("user@example.com::password123"), "user@example.com:password123");
    assert.equal(cleanLine("user@example.com||password123"), "user@example.com:password123");

    // SQL tuples and statements
    assert.equal(cleanLine("('alice@example.com', 'secret'),"), "alice@example.com:secret");
    assert.equal(cleanLine("('alice@example.com', 'secret');"), "alice@example.com:secret");
    assert.equal(cleanLine("INSERT INTO users VALUES ('alice@example.com', 'secret');"), "alice@example.com:secret");
    assert.equal(cleanLine("INSERT INTO `users` (`id`, `email`, `pass`) VALUES (1, 'alice@example.com', 'secret');"), "alice@example.com:secret");
    assert.equal(cleanLine("(1, 'alice@example.com', 'secret', '2026-09-22')"), "alice@example.com:secret");
    assert.equal(cleanLine("(42, 'admin_boss', 'secret123', 'active')"), "admin_boss:secret123");
    assert.equal(cleanLine("('admin', 'secret123')"), "admin:secret123");
    assert.equal(cleanLine("(1, 'alice@example.com', NULL)"), null);

    // CSV format with URLs and quoted commas
    assert.equal(cleanLine("Google,https://accounts.google.com/,alice@gmail.com,SuperSecret123"), "alice@gmail.com:SuperSecret123");
    assert.equal(cleanLine("Google,https://accounts.google.com/,alice@gmail.com,SuperSecret123", { keepUrl: true }), "https://accounts.google.com/:alice@gmail.com:SuperSecret123");
    assert.equal(cleanLine("https://site.com,alice@gmail.com,pass123"), "alice@gmail.com:pass123");
    assert.equal(cleanLine('"alice@example.com","my,pass","extra"'), "alice@example.com:my,pass");

    // TSV format
    assert.equal(cleanLine("user@example.com\tpassword123"), "user@example.com:password123");
    assert.equal(cleanLine("https://site.com\tuser@example.com\tpassword123"), "user@example.com:password123");
    assert.equal(cleanLine("https://site.com\tuser@example.com\tpassword123", { keepUrl: true }), "https://site.com:user@example.com:password123");
    assert.equal(cleanLine("admin\tpassword123"), "admin:password123");

    // JSON trailing commas and null passwords
    assert.equal(cleanLine('{"email":"alice@example.com","password":"secret"},'), "alice@example.com:secret");
    assert.equal(cleanLine('{"email":"alice@example.com","password":"secret"};'), "alice@example.com:secret");
    assert.equal(cleanLine('{"email":"alice@example.com","password":null}'), null);
    assert.equal(cleanLine('{"email":"alice@example.com","password":""}'), null);

    // Placeholders rejection
    assert.equal(cleanLine("null:null"), null);
    assert.equal(cleanLine("undefined:undefined"), null);
    assert.equal(cleanLine("unknown:unknown"), null);
    assert.equal(cleanLine("user@example.com:null"), null);
    assert.equal(cleanLine("user@example.com:undefined"), null);
    assert.equal(cleanLine("user@example.com:(empty)"), null);
    assert.equal(cleanLine("user@example.com:<empty>"), null);
    assert.equal(cleanLine("User: victim@gmail.com"), null);
    assert.equal(cleanLine("Username | victim@gmail.com"), null);

    // Credit cards with comma and hyphen/dot expiry
    const { cleanCcLine } = require("../src/cleaner");
    assert.equal(cleanCcLine("4111111111111111,12,28,123"), "4111111111111111|12|28|123");
    assert.equal(cleanCcLine("4111111111111111|12-28|123"), "4111111111111111|12|28|123");
    assert.equal(cleanCcLine("4111111111111111|12.28|123"), "4111111111111111|12|28|123");

    // Multi-line stealer blocks with pipe and UNKNOWN passwords
    const pipeDump = [
        "URL | https://accounts.google.com/",
        "USER | victim@gmail.com",
        "PASS | SuperSecretPassword123!",
        "=========================================",
        "URL | https://facebook.com/login",
        "USER | victim@gmail.com",
        "PASS | UNKNOWN",
    ].join("\n");

    const pipeRes = cleanText(pipeDump, { keepUrl: true });
    assert.equal(pipeRes.lines.length, 1);
    assert.equal(pipeRes.lines[0], "https://accounts.google.com/:victim@gmail.com:SuperSecretPassword123!");

    // Multi-line stealer blocks with placeholder user
    const placeholderUserDump = [
        "URL | https://github.com/login",
        "USER | (empty)",
        "PASS | MyPass123!",
        "=========================================",
        "URL | https://accounts.google.com/",
        "USER | victim@gmail.com",
        "PASS | SuperSecretPassword123!",
    ].join("\n");
    const placeholderUserRes = cleanText(placeholderUserDump, { keepUrl: false });
    assert.equal(placeholderUserRes.lines.length, 1);
    assert.equal(placeholderUserRes.lines[0], "victim@gmail.com:SuperSecretPassword123!");
});



