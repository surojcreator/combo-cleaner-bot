"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const siteVault = require("../src/site-vault");
const sitesExport = require("../src/sites-export");

const CHAT = 4242;

function tempRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "sites-export-"));
}

async function seed(root) {
    await siteVault.appendLines(CHAT, "htzone.co.il", [
        "a@x.com:one",
        "b@x.com:two",
        "a@x.com:one", // dupe
    ], root, { pinned: true });
    await siteVault.appendLines(CHAT, "netflix.com", [
        "c@y.com:three",
    ], root, { pinned: true });
    siteVault.setActive(CHAT, "netflix.com", root);
}

test("readSaves totals every site save", async () => {
    const root = tempRoot();
    try {
        await seed(root);
        const data = sitesExport.readSaves(CHAT, root);
        assert.equal(data.sites.length, 2);
        assert.equal(data.totalLines, 3);
        assert.ok(data.totalBytes > 0);
        assert.equal(data.active, "netflix.com");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("buildIndex lists each site and marks the pinned one", async () => {
    const root = tempRoot();
    try {
        await seed(root);
        const data = sitesExport.readSaves(CHAT, root);
        const text = sitesExport.buildIndex(data, { chatId: CHAT });
        assert.match(text, /# Combo Cleaner - pinned site export/);
        assert.match(text, /# chat: 4242/);
        assert.match(text, /# pinned: netflix\.com/);
        assert.match(text, /htzone\.co\.il/);
        assert.match(text, /netflix\.com.*<- pinned/);
        assert.match(text, /unique credential pair/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("buildIndex handles an empty vault without throwing", () => {
    const text = sitesExport.buildIndex({ sites: [], totalLines: 0, totalBytes: 0, active: null }, {});
    assert.match(text, /\(no saves yet\)/);
    assert.match(text, /# sites: 0/);
});

test("writeZip contains one .txt per site plus index.txt", async () => {
    const root = tempRoot();
    try {
        await seed(root);
        const bundle = sitesExport.writeZip(CHAT, root);
        assert.ok(fs.existsSync(bundle.zipPath));
        assert.equal(bundle.count, 2);
        assert.equal(bundle.totalLines, 3);
        assert.match(bundle.filename, /^pinned-sites-\d{8}-\d{6}\.zip$/);

        const AdmZip = require("adm-zip");
        const names = new AdmZip(bundle.zipPath).getEntries().map((e) => e.entryName).sort();
        assert.deepEqual(names, ["htzone.co.il.txt", "index.txt", "netflix.com.txt"]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("writeZip throws a typed error when there is nothing to send", () => {
    const root = tempRoot();
    try {
        assert.throws(() => sitesExport.writeZip(CHAT, root), (err) => err.code === "NO_SITE_SAVES");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("writeIndexFile is a standalone manifest", async () => {
    const root = tempRoot();
    try {
        await seed(root);
        const file = sitesExport.writeIndexFile(CHAT, root);
        assert.ok(fs.existsSync(file.indexPath));
        assert.equal(file.count, 2);
        const text = fs.readFileSync(file.indexPath, "utf8");
        assert.match(text, /htzone\.co\.il/);
        assert.match(text, /netflix\.com/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("siteFileInfo resolves a single site and rejects unknown ones", async () => {
    const root = tempRoot();
    try {
        await seed(root);
        const info = sitesExport.siteFileInfo(CHAT, "HTZONE.co.il", root);
        assert.ok(info, "normalization should accept a mixed-case host");
        assert.equal(info.filename, "htzone.co.il.txt");
        assert.equal(info.lines, 2);
        assert.equal(sitesExport.siteFileInfo(CHAT, "nope.example", root), null);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("pruneOldExports removes only expired zips", () => {
    const AdmZip = require("adm-zip");
    const root = tempRoot();
    const dir = path.join(os.tmpdir(), "combo-site-exports");
    fs.mkdirSync(dir, { recursive: true });
    const oldFile = path.join(dir, `old-${process.pid}.zip`);
    const freshFile = path.join(dir, `fresh-${process.pid}.zip`);
    new AdmZip().writeZip(oldFile);
    new AdmZip().writeZip(freshFile);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, twoHoursAgo, twoHoursAgo);
    try {
        const removed = sitesExport.pruneOldExports();
        assert.ok(removed >= 1);
        assert.equal(fs.existsSync(oldFile), false);
        assert.equal(fs.existsSync(freshFile), true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        try { fs.unlinkSync(freshFile); } catch { /* ignore */ }
    }
});

test("humanSize picks a readable unit", () => {
    assert.equal(sitesExport.humanSize(0), "0 B");
    assert.equal(sitesExport.humanSize(2048), "2.0 KB");
    assert.match(sitesExport.humanSize(5 * 1024 * 1024), /MB$/);
});
