import assert from "node:assert/strict";
import test from "node:test";

import {
  filterHistoryItems,
  normalizeHostname,
  parseHostnames,
  parseSmartTerms,
  sortByLastVisit,
} from "../history-utils.mjs";

const items = [
  {
    title: "Home / X",
    url: "https://x.com/home",
    lastVisitTime: 30,
  },
  {
    title: "Legacy X profile",
    url: "https://mobile.twitter.com/example",
    lastVisitTime: 20,
  },
  {
    title: "Example",
    url: "https://notx.com/x.com",
    lastVisitTime: 10,
  },
  {
    title: "The letter X appears here",
    url: "https://example.com/article",
    lastVisitTime: 40,
  },
];

test("normalizes hostname input", () => {
  assert.equal(normalizeHostname(" X.COM/path "), "x.com");
  assert.equal(normalizeHostname("https://Mobile.Twitter.com/foo"), "mobile.twitter.com");
  assert.equal(normalizeHostname("%%%"), null);
});

test("parses and deduplicates multiple hostnames", () => {
  assert.deepEqual(parseHostnames("x.com, twitter.com x.com"), ["x.com", "twitter.com"]);
});

test("parses and deduplicates smart search terms", () => {
  assert.deepEqual(parseSmartTerms("X, twitter x"), ["x", "twitter"]);
});

test("smart search treats a short site name as an exact hostname label", () => {
  const results = filterHistoryItems(items, "X", "smart");
  assert.deepEqual(results.map((item) => item.url), ["https://x.com/home"]);
});

test("smart search supports site labels and full domains together", () => {
  const results = filterHistoryItems(items, "X, twitter.com", "smart");
  assert.deepEqual(results.map((item) => item.url), [
    "https://x.com/home",
    "https://mobile.twitter.com/example",
  ]);
});

test("smart search uses text matching for non-latin terms", () => {
  const chineseItems = [
    { title: "小红书网页版", url: "https://example.com/red" },
    { title: "普通页面", url: "https://example.com/other" },
  ];
  const results = filterHistoryItems(chineseItems, "小红书", "smart");
  assert.equal(results.length, 1);
});

test("matches an exact hostname without URL substring false positives", () => {
  const results = filterHistoryItems(items, "x.com", "host-exact");
  assert.deepEqual(results.map((item) => item.url), ["https://x.com/home"]);
});

test("matches a hostname and its subdomains", () => {
  const results = filterHistoryItems(items, "twitter.com", "host-subdomains");
  assert.deepEqual(results.map((item) => item.url), [
    "https://mobile.twitter.com/example",
  ]);
});

test("supports multiple domains", () => {
  const results = filterHistoryItems(items, "x.com, twitter.com", "host-subdomains");
  assert.deepEqual(results.map((item) => item.url), [
    "https://x.com/home",
    "https://mobile.twitter.com/example",
  ]);
});

test("contains mode searches title and URL", () => {
  const results = filterHistoryItems(items, "letter x", "contains");
  assert.equal(results.length, 1);
  assert.equal(results[0].url, "https://example.com/article");
});

test("sorts newest history first without mutating input", () => {
  const sorted = sortByLastVisit(items);
  assert.equal(sorted[0].lastVisitTime, 40);
  assert.equal(items[0].lastVisitTime, 30);
});
