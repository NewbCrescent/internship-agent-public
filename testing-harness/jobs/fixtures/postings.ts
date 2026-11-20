/**
 * Synthetic postings. They mimic the structural variety of real listings
 * without checking a real employer's wording into source, per AGENTS.md.
 * Real postings live in the git-ignored corpus the benchmark reads.
 */

/** Conventional headed sections with bullets. */
export const HEADED_BULLETS = `Software Engineering Intern
Aurora Labs - Austin, TX

About the role
Join our fictional platform team for a summer internship.

Minimum qualifications:
- Must be enrolled in a Bachelor's degree program in Computer Science
- Experience with Python and SQL
- Available to start in June 2027

Preferred qualifications:
- Familiarity with Kubernetes is a plus
- Exposure to Kafka preferred

Compensation: $45 - $62 per hour.
Applicants must be legally authorized to work in the United States. We will not sponsor employment visas for this role.
`;

/** Prose-heavy, no headings, unicode bullets, inline requirements. */
export const PROSE_STYLE = `Machine Learning Intern at Vesper Analytics

We are a fictional research group working on applied modeling. This is a fully remote internship.

What you'll need 
• Strong programming skills in Python
• Coursework in machine learning is required
• Graduating between December 2027 and May 2028

Nice to have
• PyTorch experience
• Familiarity with distributed systems

The stipend for this position is competitive.
`;

/** Minimal posting: no compensation, no constraints, no preferred section. */
export const SPARSE = `Backend Engineering Intern

Company: Tidepool Systems

Responsibilities include building fictional internal tooling and writing tests.

Requirements:
- Must know at least one of Go, Rust, or Java
- Comfortable working in Linux environments
`;

/** Requirements stated only in prose, with a preferred cue inside a hard block. */
export const MIXED_CUES = `Data Engineering Intern - Northwind Freight
Location: Chicago, IL (hybrid)

Basic qualifications:
- Bachelor's degree in progress
- Experience with SQL required
- Airflow experience preferred
- Docker exposure is a bonus

Start date: May 2027. This is a 12-week program.
Salary range: $30/hour.
`;
