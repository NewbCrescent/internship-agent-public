import { getDatabase, seedDevelopmentData } from "../src/index";

const database = getDatabase();
seedDevelopmentData(database);
process.stdout.write("Seeded fictional candidate and internship in the local SQLite database.\n");
