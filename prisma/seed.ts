import { PrismaClient, TagType, type Role, type User, type Tag } from "@prisma/client";
import { hashPassword } from "../src/auth/util";

// Seed types
interface SeedUser {
  email: string;
  name: string;
  password: string;
  roles: string[]; // role names
}

interface SeedDoc {
  title: string;
  tags: string[]; // tag contents
  views?: number;
  updatedCount?: number;
}

const prisma = new PrismaClient();

async function ensureRole(name: string): Promise<Role> {
  const existing = await prisma.role.findFirst({ where: { name } });
  if (existing) return existing;
  return prisma.role.create({ data: { name } });
}

async function ensureTag(type: TagType, content: string): Promise<Tag> {
  return prisma.tag.upsert({
    where: { content },
    update: {},
    create: { type, content },
  });
}

async function ensureUser(u: SeedUser): Promise<User> {
  const existing = await prisma.user.findUnique({ where: { email: u.email } });
  if (existing) return existing;
  const roleRecords: Role[] = [];
  for (const r of u.roles) roleRecords.push(await ensureRole(r));
  return prisma.user.create({
    data: {
      email: u.email,
      name: u.name,
      password: await hashPassword(u.password),
      roles: { connect: roleRecords.map((r) => ({ id: r.id })) },
    },
  });
}

async function createDocuments(docs: SeedDoc[]): Promise<void> {
  // prepare tags map
  const tagRecords: Record<string, Tag> = {};
  async function getTag(content: string): Promise<Tag> {
    if (tagRecords[content]) return tagRecords[content];
    // Heuristics for demo tag types
    const type = content.match(/^\d{4,}$/) ? TagType.STD_NUM : content.match(/^(CS|EE|ME|BIO|MATH)$/) ? TagType.MAJOR : TagType.CUSTOM;
    const t = await ensureTag(type, content);
    tagRecords[content] = t;
    return t;
  }

  for (const d of docs) {
    // Avoid duplicates by title
    const exists = await prisma.document.findFirst({ where: { title: d.title } });
    if (exists) continue;
    const connectTags = [] as { id: string }[];
    for (const tg of d.tags) {
      const t = await getTag(tg);
      connectTags.push({ id: t.id });
    }
    await prisma.document.create({
      data: {
        title: d.title,
        contentMd: "",
        embedding: [], // lazy embedding computed on-demand
        views: d.views ?? Math.floor(Math.random() * 200),
        updatedCount: d.updatedCount ?? Math.floor(Math.random() * 20),
        editable: true,
        tags: { connect: connectTags },
      },
    });
  }
}

async function main(): Promise<void> {
  await prisma.$connect();

  // Roles & Users
  const users: SeedUser[] = [
    { email: "admin@example.com", name: "Admin", password: "admin123!", roles: ["admin"] },
    { email: "user@example.com", name: "User", password: "user123!", roles: ["user"] },
  ];
  for (const u of users) await ensureUser(u);

  // Tags
  const baseTags = [
    { type: TagType.MAJOR, content: "CS" },
    { type: TagType.MAJOR, content: "EE" },
    { type: TagType.CUSTOM, content: "Notice" },
    { type: TagType.CUSTOM, content: "Guide" },
    { type: TagType.STD_NUM, content: "20230001" },
  ];
  for (const t of baseTags) await ensureTag(t.type, t.content);

  // Documents
  const docs: SeedDoc[] = [
    { title: "Bun과 Elysia 시작하기", tags: ["Guide", "CS"], views: 150, updatedCount: 5 },
    { title: "Prisma 사용 가이드", tags: ["Guide", "CS"], views: 120, updatedCount: 8 },
    { title: "공지: 서버 점검 일정", tags: ["Notice"], views: 200, updatedCount: 2 },
    { title: "전기전자 개론", tags: ["EE"], views: 80, updatedCount: 3 },
    { title: "학번 20230001 포트폴리오", tags: ["20230001", "CS"], views: 60, updatedCount: 10 },
  ];
  await createDocuments(docs);

  console.log("Seed completed");
}

main()
  .catch((e) => {
    console.error("Seed error", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
