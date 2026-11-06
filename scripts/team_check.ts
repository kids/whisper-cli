// Ad-hoc verification for /data/dev/whisper-cli/src/team.ts pure logic
import {
  AGREE_SENTINEL,
  MAX_ROLES,
  buildRolePrompt,
  buildRosterPrompt,
  buildSynthesisPrompt,
  buildTranscript,
  fallbackRoster,
  getTeam,
  isAgree,
  metaSessionKey,
  moderatorSessionKey,
  parseRoster,
  roleSessionKey,
  setTeam,
  slugifyRoleId,
  stripSentinel,
  type Speech,
} from "/data/dev/whisper-cli/src/team.ts";
import { rmSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

console.log("== parseRoster ==");
const clean = '{"roles":[{"id":"cost","name":"成本工程师","prompt":"只看成本"},{"id":"risk","name":"风险官","prompt":"只看风险"},{"id":"exec","name":"落地负责人","prompt":"只看执行"}]}';
check("clean json → 3 roles", parseRoster(clean)?.length === 3);

const noisy = "好的，以下是角色：\n```json\n" + clean + "\n```\n希望有帮助！";
check("fenced + prose → 3 roles", parseRoster(noisy)?.length === 3);

const chineseOnly = '{"roles":[{"name":"目标与收益","prompt":"a"},{"name":"风险与代价","prompt":"b"},{"name":"落地与执行","prompt":"c"}]}';
const zh = parseRoster(chineseOnly);
check("no id → fallback ids role1/role2/role3", zh?.map(r => r.id).join(",") === "role1,role2,role3", JSON.stringify(zh?.map(r => r.id)));

check("single role → null (need >=2)", parseRoster('{"roles":[{"name":"独苗","prompt":"x"}]}') === null);
check("garbage → null", parseRoster("我不知道该输出什么") === null);
check("broken json → null", parseRoster('{"roles":[{"name":"a"') === null);
check("missing prompt → skipped", parseRoster('{"roles":[{"name":"a","prompt":"x"},{"name":"b"}]}') === null);
check(`caps at MAX_ROLES=${MAX_ROLES}`, parseRoster(JSON.stringify({ roles: Array.from({ length: 9 }, (_, i) => ({ id: `r${i}`, name: `角色${i}`, prompt: "p" })) }))?.length === MAX_ROLES);
check("duplicate ids deduped", parseRoster('{"roles":[{"id":"x","name":"a","prompt":"p"},{"id":"x","name":"b","prompt":"p"}]}')?.map(r => r.id).join(",") === "x,x-2");

console.log("== slugify ==");
check("chinese → fallback", slugifyRoleId("成本工程师", 2) === "role2");
check("spaces → dash", slugifyRoleId("Cost Engineer") === "cost-engineer");
check("keeps dashes", slugifyRoleId("a--b") === "a-b");

console.log("== sentinel / agreement ==");
check("[[同意]] detected", isAgree(`${AGREE_SENTINEL}\n我的保留意见是不确定性`));
check("leading spaces ok", isAgree(`   ${AGREE_SENTINEL} x`));
check("normal speech not agreed", !isAgree("我认为应该先做成本测算"));
check("sentinel stripped from body", stripSentinel(`${AGREE_SENTINEL}\n保留意见：时间紧`) === "保留意见：时间紧");

console.log("== transcript digest ==");
const speeches: Speech[] = [
  { roleId: "a", name: "甲", text: "A".repeat(500), agreed: false, round: 1 },
  { roleId: "b", name: "乙", text: "B".repeat(500), agreed: false, round: 1 },
  { roleId: "c", name: "丙", text: "C".repeat(1200), agreed: false, round: 2 },
];
const d1 = buildTranscript(speeches, 1200);
check("digest respects char budget", d1.length <= 1200, `len=${d1.length}`);
check("digest keeps newest speech", d1.includes("【丙·R2】"));
check("digest drops oldest when over budget", !d1.includes("【甲·R1】"));
check("empty → placeholder", buildTranscript([]) === "（暂无发言）");

console.log("== prompt builders ==");
const role = fallbackRoster()[0];
const rp = buildRolePrompt({ role, topic: "评估三个方案", userText: "选哪个", transcript: "（暂无发言）", round: 2, maxRounds: 3 });
check("role prompt has role name", rp.includes("目标与收益"));
check("role prompt has topic/user/round", rp.includes("评估三个方案") && rp.includes("选哪个") && rp.includes("第 2/3 轮"));
check("role prompt instructs sentinel", rp.includes(AGREE_SENTINEL));
check("roster prompt bounded by MAX_ROLES", buildRosterPrompt("x").includes(`${MAX_ROLES} 个`));
const sp = buildSynthesisPrompt({ topic: "t", userText: "u", transcript: "tr", roleNames: ["甲", "乙"] });
check("synthesis prompt converges (no per-role enumeration)", sp.includes("不要按人罗列发言") && sp.includes("甲、乙"));

console.log("== session keys ==");
check("role key namespaced", roleSessionKey("oc_1", "cost") === "oc_1#role:cost");
check("moderator/meta distinct", moderatorSessionKey("oc_1") !== metaSessionKey("oc_1") && moderatorSessionKey("oc_1") === "oc_1#moderator");
check("fallback roster ≥2 and covers 3 lenses", fallbackRoster().length === 3);
check("unknown chat → undefined", getTeam("oc_nope") === undefined);

console.log("== store round-trip ==");
setTeam({ chatId: "oc_test", topic: "临时", roles: fallbackRoster(), maxRounds: 2, createdAt: Date.now(), lastActiveAt: Date.now() });
check("setTeam readable", getTeam("oc_test")?.roles.length === 3);
async function finalize(): Promise<void> {
  await new Promise((r) => setTimeout(r, 500)); // debounced write
  const path = "/data/dev/whisper-cli/.teams.json";
  check("persisted to .teams.json", existsSync(path));
  if (existsSync(path)) {
    const raw = JSON.parse(await readFile(path, "utf8"));
    check("file contains only test entry", Object.keys(raw.teams).join(",") === "oc_test");
  }
  rmSync(path, { force: true });
  rmSync(path + ".tmp", { force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

void finalize();
