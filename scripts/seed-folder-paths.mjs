// One-off: set folder A → D:\order\A, folder B → D:\order\B.
import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
await p.salesContractFolderMapping.update({ where: { folderLetter: "A" }, data: { sourceFolderPath: "D:\\order\\A" } });
await p.salesContractFolderMapping.update({ where: { folderLetter: "B" }, data: { sourceFolderPath: "D:\\order\\B" } });
const all = await p.salesContractFolderMapping.findMany({ orderBy: { folderLetter: "asc" } });
for (const f of all) console.log(f.folderLetter, "->", JSON.stringify(f.sourceFolderPath));
await p.$disconnect();
