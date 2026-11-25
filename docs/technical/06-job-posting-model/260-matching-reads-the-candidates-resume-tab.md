Matching reads the candidate's Resume tab as well as verified evidence (the candidate chose this).
`resumeSkillsFor` collects every item of approved skill lines (split on parentheses, slashes, and commas, so "AWS (EC2, S3)" yields AWS, EC2, S3) and the dictionary technologies named in approved roles and bullets; library-only entries count, pending and archived entries do not.
A hard SKILL or EXPERIENCE requirement that names a resume skill passes with "Your resume lists …"; verified evidence keeps its own wording when both apply.
Resume skills also count toward technology overlap and preferred coverage and are never penalized as missing.
Skill names match as whole words or phrases (`mentionsSkill`), replacing a substring check that let "C" match inside "React"; squashed keys such as `nodejs` still meet spaced text such as "Node.js".
General requirements that name no skill ("real-time web applications", "at least one programming language") still need the candidate's review.
