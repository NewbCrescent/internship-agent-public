import { getDatabase, seedBrowserEvidenceData } from "../src/index";

const database = getDatabase();
seedBrowserEvidenceData(database);
database.close();
process.stdout.write("Seeded fictional browser verification data.\n");
