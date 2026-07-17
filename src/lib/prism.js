import { Prism } from "prism-react-renderer";

globalThis.Prism = Prism;

await import("prismjs/components/prism-markup-templating.js");
await import("prismjs/components/prism-php.js");

export { Prism };
