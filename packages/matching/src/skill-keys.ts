/**
 * Shared skill-key canonicalization. Evidence claim keys (`dependency:typescript`)
 * and posting technology keys (`typescript`) meet here so equivalent skills
 * compare equal without inventing new facts about either side.
 */
export function canonicalSkillKey(value: string): string {
  const last = value.toLocaleLowerCase("en-US").split(":").pop() ?? value;
  return last.replace(/[^a-z0-9+#]+/g, "");
}

/** Human-word form for substring matching inside requirement sentences. */
export function displaySkillKey(value: string): string {
  const last = value.toLocaleLowerCase("en-US").split(":").pop() ?? value;
  return last.replace(/[^a-z0-9+#]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Lowercase words and symbols only, so "Node.js" and "node js" read the same. */
function skillText(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/[^a-z0-9+#]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Whether `text` names `skill` as whole words: "Python" in "Python or Go",
 * never "C" inside "React" or "JavaScript" inside a stray "a".
 */
export function mentionsSkill(text: string, skill: string): boolean {
  const term = skillText(skill);
  if (!term) return false;
  const words = skillText(text).split(" ");
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`(?:^|[^a-z0-9+#])${escaped}(?![a-z0-9+#])`).test(words.join(" "))) return true;
  // Squashed keys ("nodejs") still meet spaced text ("Node.js" → "node js").
  const squashed = term.replace(/ /g, "");
  return words.some((_, index) => [1, 2, 3].some((size) => words.slice(index, index + size).join("") === squashed && index + size <= words.length));
}

const RELATIONAL = ["SQL", "relational databases", "relational database"];
// Phrases only: AWS covers "cloud platforms", never "Oracle Cloud".
const CLOUD = ["cloud platforms", "cloud platform", "cloud computing", "cloud services", "cloud infrastructure",
  "cloud providers", "cloud provider", "cloud technologies", "cloud environments", "cloud environment", "cloud based", "public cloud"];

/**
 * What naming a skill also establishes, keyed by canonical key: the same skill
 * under another name, or the broader skill it is a kind of. One way only, so
 * PostgreSQL covers SQL but SQL never covers PostgreSQL.
 */
const SKILL_IMPLIES: Record<string, string[]> = {
  postgresql: ["Postgres", ...RELATIONAL],
  postgres: ["PostgreSQL", ...RELATIONAL],
  mysql: RELATIONAL,
  sqlite: RELATIONAL,
  mariadb: RELATIONAL,
  sqlserver: RELATIONAL,
  microsoftsqlserver: RELATIONAL,
  redis: ["NoSQL"],
  mongodb: ["NoSQL"],
  dynamodb: ["NoSQL"],
  firebase: ["NoSQL"],
  firestore: ["NoSQL"],
  javascript: ["JS"],
  js: ["JavaScript"],
  nodejs: ["Node"],
  node: ["Node.js"],
  expressjs: ["Express"],
  express: ["Express.js"],
  react: ["ReactJS"],
  golang: ["Go"],
  go: ["Golang"],
  "c++": ["CPP"],
  cpp: ["C++"],
  kubernetes: ["K8s"],
  k8s: ["Kubernetes"],
  tailwindcss: ["Tailwind", "CSS"],
  tailwind: ["TailwindCSS", "CSS"],
  aws: ["Amazon Web Services", ...CLOUD],
  amazonwebservices: ["AWS", ...CLOUD],
  ec2: ["AWS", ...CLOUD],
  ecs: ["AWS", ...CLOUD],
  s3: ["AWS", ...CLOUD],
  gcp: ["Google Cloud", ...CLOUD],
  googlecloud: ["GCP", ...CLOUD],
  googlecloudplatform: ["GCP", "Google Cloud", ...CLOUD],
  azure: CLOUD,
  microsoftazure: ["Azure", ...CLOUD],
  machinelearning: ["ML"],
  ml: ["Machine Learning"],
  // Fine-tuning a model with QLoRA is hands-on work with large language models.
  qlora: ["LoRA", "fine-tuning", "Machine Learning", "ML", "LLM", "LLMs", "large language models", "large language model"]
};

/** A skill and everything listing it also establishes, the skill itself first. */
export function impliedSkills(skill: string): string[] {
  return [skill, ...(SKILL_IMPLIES[canonicalSkillKey(skill)] ?? [])];
}

/** The term `text` names for `skill` (the skill itself or what it implies), or null. */
export function mentionedAs(text: string, skill: string): string | null {
  return impliedSkills(skill).find((term) => mentionsSkill(text, term)) ?? null;
}
