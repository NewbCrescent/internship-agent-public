/** Every group `roleTypeForTitle` can return, in display order. */
export const ROLE_TYPES = [
  "Software engineering",
  "Data and AI",
  "Quant and finance",
  "Security",
  "Cloud and infrastructure",
  "Robotics and hardware",
  "Research",
  "Product",
  "Design",
  "Other"
] as const;
export type RoleType = (typeof ROLE_TYPES)[number];

/**
 * Conservative grouping from title text for analytics and the Jobs filter;
 * ambiguous titles stay Other. Order matters: a "Quant Developer" is quant,
 * and a "Cloud Security" role is security.
 */
export function roleTypeForTitle(title: string): RoleType {
  const value = title.toLocaleLowerCase("en-US");
  if (/\b(security|cyber\w*|infosec)\b/.test(value)) return "Security";
  if (/\b(quant\w*|trading|trader|investments?|capital markets|risk management)\b/.test(value)) return "Quant and finance";
  if (/\b(software|swe|backend|frontend|full.stack|platform|devops|developer|application development|computer science)\b/.test(value)) return "Software engineering";
  if (/\b(data|analytics|machine learning|ml|ai|artificial intelligence|deep learning|computer vision|nlp)\b/.test(value)) return "Data and AI";
  if (/\b(cloud|infrastructure|site reliability|sre|network\w*|supercomputing|hpc)\b/.test(value)) return "Cloud and infrastructure";
  if (/\b(robotics?|autonomy|autonomous|hardware|embedded|firmware|fpga|asic|electrical|mechanical)\b/.test(value)) return "Robotics and hardware";
  if (/\b(research|researcher|scientist)\b/.test(value)) return "Research";
  if (/\b(product|pm)\b/.test(value)) return "Product";
  if (/\b(design|ux|ui)\b/.test(value)) return "Design";
  return "Other";
}
