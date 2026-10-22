const idx = 771;
const re = new RegExp(`<c\\b[^>]*t="s"[^>]*><v>${idx}<\\/v>`);
console.log("source:", re.source, "len:", re.source.length);
console.log("source char0:", re.source.charCodeAt(0));
const sample = `<c r="B74" s="593" t="s"><v>771</v></c>`;
console.log("sample:", sample);
console.log("match1:", re.test(sample));

// Alternative: literal regex
const re2 = /<c\b[^>]*t="s"[^>]*><v>771<\/v>/;
console.log("re2 source:", re2.source);
console.log("re2 match:", re2.test(sample));

// Build a different way
const re3 = new RegExp(String.raw`<c\b[^>]*t="s"[^>]*><v>${idx}<\/v>`);
console.log("re3 source:", re3.source);
console.log("re3 match:", re3.test(sample));
