"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { cleanLine, cleanText, isEmail, isPhone, isUrlOrDomain } = require("../src/cleaner");

test("keeps plain email:password", () => {
    assert.equal(cleanLine("user@example.com:Passw0rd!"), "user@example.com:Passw0rd!");
});

test("keeps plain phone:password", () => {
    assert.equal(cleanLine("15551234567:secret"), "15551234567:secret");
});

test("normalizes whitespace around the colon", () => {
    assert.equal(cleanLine("  user@example.com :  secret "), "user@example.com:secret");
});

test("extracts login:password from a URL:login:password line", () => {
    assert.equal(
        cleanLine("https://rewards.example.co.il/path/:027223395:Wekselma7"),
        "027223395:Wekselma7",
    );
});

test("extracts login:password after a URL with a space separator", () => {
    assert.equal(
        cleanLine("https://rewards.example.co.il/page 027152230:dani1234"),
        "027152230:dani1234",
    );
});

test("extracts login:password after a domain prefix", () => {
    assert.equal(
        cleanLine("rewards.example.co.il:weintraubetattoo:weintraube867"),
        "weintraubetattoo:weintraube867",
    );
});

test("extracts email login after a domain prefix", () => {
    assert.equal(
        cleanLine("rewards.example.co.il:bodywanted@gmail.com:145871643"),
        "bodywanted@gmail.com:145871643",
    );
});

test("handles pipe separators", () => {
    assert.equal(
        cleanLine("https://rewards.example.co.il/|043154756|saarofri2014"),
        "043154756:saarofri2014",
    );
});

test("handles colon in the value plus trailing path", () => {
    assert.equal(
        cleanLine("https://rewards.example.co.il/forms/Register/:samroma40:318016"),
        "samroma40:318016",
    );
});

test("keeps password that itself contains a colon", () => {
    assert.equal(
        cleanLine("user@example.com:a:b:c"),
        "user@example.com:a:b:c",
    );
});

test("drops pure URL/domain lines with no credentials", () => {
    assert.equal(cleanLine("https://example.com:443"), null);
    assert.equal(cleanLine("example.com:password"), null);
    assert.equal(cleanLine("www.example.com:8080"), null);
    assert.equal(cleanLine("1.2.3.4:443"), null);
});

test("drops lines with no colon", () => {
    assert.equal(cleanLine("just some text"), null);
});

test("drops lines whose login side is empty", () => {
    assert.equal(cleanLine(":password"), null);
});

test("does not treat email as a domain", () => {
    assert.equal(isUrlOrDomain("user@example.com"), false);
    assert.equal(isEmail("user@example.com"), true);
});

test("phone detection requires 7-15 digits", () => {
    assert.equal(isPhone("123456"), false);
    assert.equal(isPhone("1234567"), true);
    assert.equal(isPhone("+1 (555) 123-4567"), true);
    assert.equal(isPhone("1234567890123456"), false); // 16 digits
});

test("keeps the exact american-express style samples", () => {
    const samples = [
        [
            "https://rewards.americanexpress.co.il/rewards/cinema-tickets/cinema-globus-max-2599 027152230:dani1234",
            "027152230:dani1234",
        ],
        [
            "https://rewards.americanexpress.co.il/rewards/cinema-tickets/cinema-city-2571 031555014:NULL",
            "031555014:NULL",
        ],
        [
            "rewards.americanexpress.co.il:bodywanted@gmail.com:145871643",
            "bodywanted@gmail.com:145871643",
        ],
        [
            "https://rewards.americanexpress.co.il/search-pages/Portal-Search-Page/|043154756|saarofri2014",
            "043154756:saarofri2014",
        ],
        [
            "https://rewards.americanexpress.co.il/rewards/electronic-gadgets/ksp-3236/:+972523656511:q1w2e3r4",
            "+972523656511:q1w2e3r4",
        ],
        [
            "https://rewards.americanexpress.co.il/|040865180|017945",
            "040865180:017945",
        ],
    ];
    for (const [input, expected] of samples) {
        assert.equal(cleanLine(input), expected, `for input: ${input}`);
    }
});

test("cleanText dedupes and counts", () => {
    const input = [
        "user@example.com:pass1",
        "user@example.com:pass1", // duplicate
        "15551234567:pass2",
        "https://example.com:443", // dropped URL (no credential)
        "example.com:80", // dropped domain (no credential)
        "", // blank
    ].join("\n");

    const { lines, stats } = cleanText(input);
    assert.deepEqual(lines, ["user@example.com:pass1", "15551234567:pass2"]);
    assert.equal(stats.kept, 2);
    assert.equal(stats.duplicates, 1);
    assert.equal(stats.dropped, 2); // URL + domain; blank lines are not counted
});

test("cleanText can disable dedupe", () => {
    const input = "user@example.com:pass1\nuser@example.com:pass1";
    const { lines } = cleanText(input, { dedupe: false });
    assert.equal(lines.length, 2);
});

test("cleanLine with keepUrl preserves the URL/domain prefix without deleting it", () => {
    assert.equal(
        cleanLine("https://rewards.example.co.il/path/:027223395:Wekselma7", { keepUrl: true }),
        "https://rewards.example.co.il/path/:027223395:Wekselma7",
    );
    assert.equal(
        cleanLine("rewards.example.co.il:weintraubetattoo:weintraube867", { keepUrl: true }),
        "rewards.example.co.il:weintraubetattoo:weintraube867",
    );
    assert.equal(
        cleanLine("rewards.example.co.il:bodywanted@gmail.com:145871643", { keepUrl: true }),
        "rewards.example.co.il:bodywanted@gmail.com:145871643",
    );
    assert.equal(
        cleanLine("https://rewards.example.co.il/page 027152230:dani1234", { keepUrl: true }),
        "https://rewards.example.co.il/page 027152230:dani1234",
    );
    assert.equal(
        cleanLine("https://rewards.example.co.il/|043154756|saarofri2014", { keepUrl: true }),
        "https://rewards.example.co.il/|043154756|saarofri2014",
    );
    assert.equal(
        cleanLine("https://site.com:bob:secret123", { keepUrl: true }),
        "https://site.com:bob:secret123",
    );
    assert.equal(
        cleanLine("user@example.com:pass1", { keepUrl: true }),
        "user@example.com:pass1",
    );
});

test("cleanLine with keepUrl still drops bare URLs and lines without credentials", () => {
    assert.equal(cleanLine("https://example.com:443", { keepUrl: true }), null);
    assert.equal(cleanLine("example.com:password", { keepUrl: true }), null);
    assert.equal(cleanLine("www.example.com:8080", { keepUrl: true }), null);
    assert.equal(cleanLine("just some text", { keepUrl: true }), null);
    assert.equal(cleanLine("", { keepUrl: true }), null);
});

test("cleanText with keepUrl keeps URLs and checks for duplicates", () => {
    const input = [
        "https://site.com:user@mail.com:pass1",
        "https://site.com:user@mail.com:pass1", // duplicate
        "  https://site.com:user@mail.com:pass1  ", // whitespace duplicate
        "https://other.com:admin:secret",
        "https://site.com:443", // bare URL dropped
        "",
    ].join("\n");

    const { lines, stats } = cleanText(input, { keepUrl: true });
    assert.deepEqual(lines, [
        "https://site.com:user@mail.com:pass1",
        "https://other.com:admin:secret",
    ]);
    assert.equal(stats.kept, 2);
    assert.equal(stats.duplicates, 2);
    assert.equal(stats.dropped, 1);
});