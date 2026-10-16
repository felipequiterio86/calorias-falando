/* Calorias Falando — app.js */
const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.APP_CONFIG;
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const fmt = (n) => Math.round(n).toLocaleString("pt-BR");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

if (SUPABASE_URL.startsWith("COLE_AQUI")) {
  document.body.innerHTML = '<div class="screen"><div class="card"><h2>Falta configurar</h2><p>Abra o arquivo <b>config.js</b> e cole a URL e a chave do seu projeto Supabase. Veja o README.md.</p></div></div>';
  throw new Error("Supabase não configurado");
}

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
let user = null;
let profile = null;
let pending = null; // refeição aguardando confirmação
let period = "week";
let offset = 0;

// ---------- utilidades de data ----------
const pad = (n) => String(n).padStart(2, "0");
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const MESES = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const MESES_LONGO = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const DIAS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const hhmm = (iso) => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

// ---------- telas ----------
function showScreen(id) {
  ["s-auth", "s-profile", "s-app"].forEach((s) => ($("#" + s).hidden = s !== id));
  window.scrollTo(0, 0);
}
function showTab(name) {
  $$(".tab").forEach((t) => (t.hidden = t.id !== "tab-" + name));
  $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  if (name === "today") loadToday();
  if (name === "reports") loadReport();
  if (name === "me") renderMe();
}
$$(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

// ---------- autenticação ----------
function setMsg(el, text, ok = false) {
  el.textContent = text || "";
  el.classList.toggle("ok", ok);
}

$("#form-auth").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("#auth-msg");
  setMsg(msg, "Entrando...", true);
  const { error } = await sb.auth.signInWithPassword({
    email: $("#auth-email").value.trim(),
    password: $("#auth-pass").value,
  });
  if (error) setMsg(msg, error.message.includes("Invalid") ? "E-mail ou senha incorretos." : error.message);
});

$("#btn-signup").addEventListener("click", async () => {
  const msg = $("#auth-msg");
  const email = $("#auth-email").value.trim();
  const password = $("#auth-pass").value;
  if (!email || password.length < 6) return setMsg(msg, "Informe e-mail e uma senha com pelo menos 6 caracteres.");
  setMsg(msg, "Criando conta...", true);
  const { data, error } = await sb.auth.signUp({ email, password });
  if (error) return setMsg(msg, error.message);
  if (!data.session) setMsg(msg, "Conta criada! Confirme seu e-mail (veja a caixa de entrada/spam) e depois entre.", true);
});

$("#btn-logout").addEventListener("click", () => sb.auth.signOut());

sb.auth.onAuthStateChange((_evt, session) => {
  // setTimeout evita travar chamadas do supabase dentro do callback
  setTimeout(() => handleSession(session), 0);
});

async function handleSession(session) {
  if (!session) {
    user = null;
    profile = null;
    return showScreen("s-auth");
  }
  if (user && user.id === session.user.id && profile) return; // já carregado
  user = session.user;
  const { data } = await sb.from("profiles").select("*").eq("id", user.id).maybeSingle();
  profile = data;
  if (!profile || !profile.tmb) {
    openProfileForm(false);
  } else {
    showScreen("s-app");
    showTab("today");
  }
}

// ---------- perfil: IMC e TMB ----------
const calcIMC = (kg, cm) => kg / Math.pow(cm / 100, 2);
// Mifflin-St Jeor
const calcTMB = (kg, cm, age, sex) => 10 * kg + 6.25 * cm - 5 * age + (sex === "M" ? 5 : -161);
function imcLabel(v) {
  if (v < 18.5) return "abaixo do peso";
  if (v < 25) return "peso normal";
  if (v < 30) return "sobrepeso";
  if (v < 35) return "obesidade grau I";
  if (v < 40) return "obesidade grau II";
  return "obesidade grau III";
}

function openProfileForm(canCancel) {
  $("#btn-profile-cancel").hidden = !canCancel;
  if (profile) {
    $("#p-weight").value = profile.weight_kg ?? "";
    $("#p-height").value = profile.height_cm ?? "";
    $("#p-age").value = profile.age ?? "";
    $("#p-sex").value = profile.sex ?? "";
    $("#p-manual").checked = !!profile.tmb_manual;
    $("#p-imc").value = profile.tmb_manual ? profile.imc ?? "" : "";
    $("#p-tmb").value = profile.tmb_manual ? profile.tmb ?? "" : "";
  }
  $("#manual-box").hidden = !$("#p-manual").checked;
  updateCalcBox();
  setMsg($("#profile-msg"), "");
  showScreen("s-profile");
}
$("#btn-profile-cancel").addEventListener("click", () => {
  showScreen("s-app");
});
$("#p-manual").addEventListener("change", () => {
  $("#manual-box").hidden = !$("#p-manual").checked;
  updateCalcBox();
});
["p-weight", "p-height", "p-age", "p-sex", "p-imc", "p-tmb"].forEach((id) => $("#" + id).addEventListener("input", updateCalcBox));

function currentValues() {
  const kg = parseFloat($("#p-weight").value);
  const cm = parseFloat($("#p-height").value);
  const age = parseInt($("#p-age").value, 10);
  const sex = $("#p-sex").value;
  const manual = $("#p-manual").checked;
  let imc = kg && cm ? calcIMC(kg, cm) : null;
  let tmb = kg && cm && age && sex ? calcTMB(kg, cm, age, sex) : null;
  if (manual) {
    const mi = parseFloat($("#p-imc").value);
    const mt = parseFloat($("#p-tmb").value);
    if (mi) imc = mi;
    if (mt) tmb = mt;
  }
  return { kg, cm, age, sex, manual, imc, tmb };
}

function updateCalcBox() {
  const v = currentValues();
  const box = $("#calc-box");
  if (!v.imc && !v.tmb) {
    box.classList.remove("on");
    return;
  }
  box.classList.add("on");
  box.innerHTML =
    (v.imc ? `IMC: <b>${v.imc.toFixed(1)}</b> (${imcLabel(v.imc)})<br>` : "") +
    (v.tmb ? `TMB: <b>${fmt(v.tmb)} kcal/dia</b> ${v.manual ? "(informada por você)" : "(estimada pela fórmula de Mifflin-St Jeor)"}` : "");
}

$("#form-profile").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("#profile-msg");
  const v = currentValues();
  if (!v.sex) return setMsg(msg, "Selecione o sexo.");
  if (!v.imc || !v.tmb) return setMsg(msg, "Preencha os dados para calcular IMC e TMB.");
  const row = {
    id: user.id,
    weight_kg: v.kg,
    height_cm: v.cm,
    age: v.age,
    sex: v.sex,
    imc: Math.round(v.imc * 10) / 10,
    tmb: Math.round(v.tmb),
    tmb_manual: v.manual,
    updated_at: new Date().toISOString(),
  };
  setMsg(msg, "Salvando...", true);
  const { error } = await sb.from("profiles").upsert(row);
  if (error) return setMsg(msg, "Erro ao salvar: " + error.message);
  profile = row;
  showScreen("s-app");
  showTab("today");
});

function renderMe() {
  if (!profile) return;
  $("#me-info").innerHTML = `
    <p>E-mail: <b>${esc(user.email)}</b></p>
    <p>Peso: <b>${profile.weight_kg} kg</b> · Altura: <b>${profile.height_cm} cm</b> · Idade: <b>${profile.age}</b></p>
    <p>IMC: <b>${profile.imc}</b> (${imcLabel(profile.imc)})</p>
    <p>TMB: <b>${fmt(profile.tmb)} kcal/dia</b> ${profile.tmb_manual ? "(manual)" : "(calculada)"}</p>
    <p class="tip">💡 Dica: uma balança de bioimpedância dá IMC e TMB mais precisos. Você pode digitar esses valores em “Editar dados”.</p>`;
}
$("#btn-edit-profile").addEventListener("click", () => openProfileForm(true));

// ---------- hoje ----------
async function fetchMeals(from, to) {
  const { data, error } = await sb
    .from("meals")
    .select("*")
    .gte("eaten_at", from.toISOString())
    .lt("eaten_at", to.toISOString())
    .order("eaten_at", { ascending: true });
  if (error) throw error;
  return data || [];
}

async function loadToday() {
  const now = new Date();
  const from = startOfDay(now);
  $("#today-date").textContent = `${DIAS[now.getDay()]}, ${now.getDate()} de ${MESES_LONGO[now.getMonth()]}`;
  let meals = [];
  try {
    meals = await fetchMeals(from, addDays(from, 1));
  } catch (e) {
    setMsg($("#meal-msg"), "Erro ao carregar diário: " + e.message);
  }
  const total = meals.reduce((s, m) => s + Number(m.total_kcal), 0);
  $("#today-total").textContent = fmt(total);
  const tmb = profile?.tmb || 0;
  const pct = tmb ? Math.min(100, (total / tmb) * 100) : 0;
  const bar = $("#today-bar");
  bar.style.width = pct + "%";
  bar.classList.toggle("over", tmb && total > tmb);
  $("#today-ref").textContent = tmb
    ? `Sua TMB é ${fmt(tmb)} kcal/dia · ${total <= tmb ? `faltam ${fmt(tmb - total)} kcal para a TMB` : `${fmt(total - tmb)} kcal acima da TMB`}`
    : "";

  const list = $("#meal-list");
  if (!meals.length) {
    list.innerHTML = '<div class="empty">Nenhuma refeição registrada hoje.</div>';
    return;
  }
  list.innerHTML = [...meals]
    .reverse()
    .map(
      (m) => `
    <div class="item">
      <div>
        <div class="t">${hhmm(m.eaten_at)}</div>
        <div class="d">${(m.items || []).map((i) => `${esc(i.name)} <small>${i.grams}g · ${i.kcal} kcal${i.estimated ? " (estimado)" : ""}</small>`).join("<br>") || esc(m.description)}</div>
        <button class="edit" data-id="${m.id}">Editar</button> <button class="del" data-id="${m.id}">Excluir</button>
      </div>
      <div class="k">${fmt(m.total_kcal)} kcal</div>
    </div>`
    )
    .join("");
  $$("#meal-list .edit").forEach((b) =>
    b.addEventListener("click", () => {
      const m = meals.find((x) => String(x.id) === b.dataset.id);
      if (!m) return;
      const items = (m.items || []).map((i) => ({ ...i }));
      if (!items.length) items.push({ name: m.description || "", grams: 100, kcal: m.total_kcal || 0, protein_g: 0, carbs_g: 0, fat_g: 0, estimated: false });
      pending = { id: m.id, text: "", items, total: m.total_kcal, eaten_at: m.eaten_at };
      openModal();
    })
  );
  $$("#meal-list .del").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("Excluir esta refeição do diário?")) return;
      const { error } = await sb.from("meals").delete().eq("id", b.dataset.id);
      if (error) setMsg($("#meal-msg"), error.message);
      else loadToday();
    })
  );
}

// ---------- voz (grava o áudio e o Gemini entende direto) ----------
const micBtn = $("#btn-mic");
const micStatus = $("#mic-status");
const mealText = $("#meal-text");
let mediaRec = null, chunks = [], stream = null, recTimer = null, recCtx = null;

// "contexto" = qual caixa de entrada está em uso (tela Hoje ou detalhe de um dia nos fechamentos)
const mainCtx = {
  mic: micBtn, status: micStatus, def: micStatus.textContent, text: mealText,
  msg: $("#meal-msg"), btn: $("#btn-calc"), when: () => null,
};
const dayCtx = {
  mic: $("#day-mic"), status: $("#day-mic-status"), def: $("#day-mic-status").textContent, text: $("#day-text"),
  msg: $("#day-msg"), btn: $("#day-calc"),
  when: () => {
    const [y, m, d] = openDay.split("-").map(Number);
    const n = new Date();
    return new Date(y, m - 1, d, n.getHours(), n.getMinutes());
  },
};

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1]);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

async function startRec(ctx) {
  setMsg(ctx.msg, "");
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    return setMsg(ctx.msg, "Gravação não suportada aqui. Digite no campo.");
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (_) {
    return setMsg(ctx.msg, "Permita o uso do microfone no navegador.");
  }
  chunks = [];
  recCtx = ctx;
  mediaRec = new MediaRecorder(stream);
  mediaRec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  mediaRec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    clearTimeout(recTimer);
    ctx.mic.classList.remove("rec");
    ctx.status.textContent = ctx.def;
    const blob = new Blob(chunks, { type: mediaRec.mimeType || "audio/webm" });
    if (blob.size < 1500) return setMsg(ctx.msg, "Não ouvi nada. Tente de novo.");
    const mime = (blob.type || "audio/webm").split(";")[0];
    calculate({ audio: await blobToBase64(blob), mime }, ctx);
  };
  mediaRec.start();
  ctx.mic.classList.add("rec");
  ctx.status.textContent = "Gravando... fale o alimento e o peso. Toque de novo para terminar.";
  recTimer = setTimeout(() => mediaRec.state === "recording" && mediaRec.stop(), 60000);
}

function wireMic(ctx) {
  ctx.mic.addEventListener("click", () => {
    if (mediaRec && mediaRec.state === "recording") {
      if (recCtx === ctx) mediaRec.stop();
    } else startRec(ctx);
  });
}
wireMic(mainCtx);
wireMic(dayCtx);

// ---------- calcular calorias ----------
mainCtx.btn.addEventListener("click", () => calculate(null, mainCtx));
dayCtx.btn.addEventListener("click", () => calculate(null, dayCtx));

async function calculate(audioPayload, ctx = mainCtx) {
  const isAudio = audioPayload && audioPayload.audio;
  const text = ctx.text.value.trim();
  const msg = ctx.msg;
  if (!isAudio && text.length < 2) return setMsg(msg, "Fale ou digite o que você comeu.");
  const btn = ctx.btn;
  btn.disabled = true;
  btn.textContent = "Calculando...";
  setMsg(msg, "");
  try {
    const { data, error } = await sb.functions.invoke("parse-meal", { body: isAudio ? audioPayload : { text } });
    if (error) {
      let detail = error.message;
      try {
        const j = await error.context.json();
        if (j?.error) detail = j.error;
      } catch (_) {}
      throw new Error(detail);
    }
    if (data?.error) throw new Error(data.error);
    const when = ctx.when();
    pending = { text: data.transcript || text, items: data.items, total: data.total_kcal, eaten_at: when ? when.toISOString() : undefined };
    openModal();
  } catch (e) {
    setMsg(msg, e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Calcular calorias";
  }
}

function recalcTotal() {
  pending.total = pending.items.reduce((s, i) => s + (Number(i.kcal) || 0), 0);
  $("#modal-total").textContent = fmt(pending.total);
}

function renderModalItems() {
  const box = $("#modal-items");
  box.innerHTML = pending.items
    .map(
      (i, n) => `<div class="edit-item" data-n="${n}">
      <input class="e-name" value="${esc(i.name)}" placeholder="Alimento" aria-label="Alimento">
      <div class="e-row">
        <label>g <input class="e-grams" type="number" inputmode="decimal" min="0" step="1" value="${i.grams}"></label>
        <label>kcal <input class="e-kcal" type="number" inputmode="decimal" min="0" step="1" value="${i.kcal}"></label>
        <button type="button" class="e-del" aria-label="Remover item">✕</button>
      </div>
      <div class="t">P ${i.protein_g}g · C ${i.carbs_g}g · G ${i.fat_g}g${i.estimated ? " · peso estimado" : ""}</div>
    </div>`
    )
    .join("");
  if (!pending.items.length) box.innerHTML = '<div class="empty">Sem itens. Adicione um abaixo.</div>';
  $$("#modal-items .edit-item").forEach((row) => {
    const it = pending.items[Number(row.dataset.n)];
    row.querySelector(".e-name").addEventListener("input", (e) => (it.name = e.target.value));
    // base de referência: kcal e macros por peso original (não se perde ao apagar o campo)
    if (!it._b) it._b = { g: it.grams, k: it.kcal, p: it.protein_g, c: it.carbs_g, f: it.fat_g };
    row.querySelector(".e-grams").addEventListener("input", (e) => {
      const g = Math.max(0, Number(e.target.value) || 0);
      const b = it._b;
      if (b.g > 0) {
        const f = g / b.g;
        it.kcal = Math.round(b.k * f);
        it.protein_g = Math.round(b.p * f * 10) / 10;
        it.carbs_g = Math.round(b.c * f * 10) / 10;
        it.fat_g = Math.round(b.f * f * 10) / 10;
        row.querySelector(".e-kcal").value = it.kcal;
        row.querySelector(".t").textContent = `P ${it.protein_g}g · C ${it.carbs_g}g · G ${it.fat_g}g`;
      }
      it.grams = g;
      it.estimated = false;
      recalcTotal();
    });
    row.querySelector(".e-kcal").addEventListener("input", (e) => {
      it.kcal = Math.max(0, Math.round(Number(e.target.value) || 0));
      // se a pessoa corrigiu as kcal na mão, a nova referência passa a ser esse valor para o peso atual
      if (it.grams > 0) it._b = { g: it.grams, k: it.kcal, p: it.protein_g, c: it.carbs_g, f: it.fat_g };
      recalcTotal();
    });
    row.querySelector(".e-del").addEventListener("click", () => {
      pending.items.splice(Number(row.dataset.n), 1);
      renderModalItems();
    });
  });
  recalcTotal();
}

function openModal() {
  $("#modal-title").textContent = pending.id ? "Editar refeição" : "Confirmar refeição";
  $("#modal-text").textContent = pending.text ? `“${pending.text}”` : "";
  $("#modal-save").textContent = pending.id ? "Salvar alterações" : "Salvar no diário";
  $("#modal-when").value = toLocalInput(new Date(pending.eaten_at || Date.now()));
  renderModalItems();
  $("#modal").hidden = false;
}
$("#modal-add").addEventListener("click", () => {
  pending.items.push({ name: "", grams: 100, kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, estimated: false });
  renderModalItems();
});
$("#modal-cancel").addEventListener("click", () => {
  pending = null;
  $("#modal").hidden = true;
});
$("#modal-save").addEventListener("click", async () => {
  if (!pending) return;
  pending.items = pending.items.filter((i) => (i.name || "").trim() || i.kcal > 0);
  pending.items = pending.items.map(({ _b, ...rest }) => ({ ...rest, name: (rest.name || "").trim() || "Item" }));
  if (!pending.items.length) return alert("Adicione pelo menos um item.");
  recalcTotal();
  const btn = $("#modal-save");
  btn.disabled = true;
  const whenVal = $("#modal-when").value;
  const eatenAt = whenVal && !isNaN(new Date(whenVal)) ? new Date(whenVal).toISOString() : pending.eaten_at || new Date().toISOString();
  const fields = { eaten_at: eatenAt, description: pending.text || pending.items.map((i) => i.name).join(", "), total_kcal: pending.total, items: pending.items };
  const { error } = pending.id
    ? await sb.from("meals").update(fields).eq("id", pending.id)
    : await sb.from("meals").insert({ user_id: user.id, ...fields });
  btn.disabled = false;
  if (error) return alert("Erro ao salvar: " + error.message);
  const edited = !!pending.id;
  pending = null;
  $("#modal").hidden = true;
  mealText.value = "";
  $("#day-text").value = "";
  setMsg($("#meal-msg"), edited ? "Refeição atualizada ✔" : "Refeição salva no diário ✔", true);
  refreshViews();
});

// ---------- fechamentos (semana / mês / ano) ----------
$$(".seg button").forEach((b) =>
  b.addEventListener("click", () => {
    period = b.dataset.period;
    offset = 0;
    $$(".seg button").forEach((x) => x.classList.toggle("active", x === b));
    loadReport();
  })
);
$("#range-prev").addEventListener("click", () => {
  offset--;
  loadReport();
});
$("#range-next").addEventListener("click", () => {
  if (offset < 0) {
    offset++;
    loadReport();
  }
});

function getRange() {
  const today = startOfDay(new Date());
  if (period === "week") {
    const dow = (today.getDay() + 6) % 7; // segunda = 0
    const start = addDays(today, -dow + offset * 7);
    const end = addDays(start, 7);
    const last = addDays(end, -1);
    return { start, end, label: `${start.getDate()} ${MESES[start.getMonth()]} – ${last.getDate()} ${MESES[last.getMonth()]}`, buckets: 7 };
  }
  if (period === "month") {
    const start = new Date(today.getFullYear(), today.getMonth() + offset, 1);
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
    return { start, end, label: `${MESES_LONGO[start.getMonth()]} de ${start.getFullYear()}`, buckets: Math.round((end - start) / 864e5) };
  }
  const y = today.getFullYear() + offset;
  return { start: new Date(y, 0, 1), end: new Date(y + 1, 0, 1), label: String(y), buckets: 12 };
}

async function loadReport() {
  const { start, end, label } = getRange();
  $("#range-label").textContent = label;
  $("#range-next").disabled = offset >= 0;
  let meals = [];
  try {
    meals = await fetchMeals(start, end);
  } catch (e) {
    $("#report-list").innerHTML = `<div class="empty">Erro: ${esc(e.message)}</div>`;
    return;
  }

  // agrupa
  const groups = []; // {label, key, total, count}
  if (period === "year") {
    for (let m = 0; m < 12; m++) groups.push({ key: String(m), label: MESES[m], total: 0, days: new Set() });
    meals.forEach((x) => {
      const d = new Date(x.eaten_at);
      const g = groups[d.getMonth()];
      g.total += Number(x.total_kcal);
      g.days.add(dayKey(d));
    });
  } else {
    for (let d = new Date(start); d < end; d = addDays(d, 1)) {
      groups.push({
        key: dayKey(d),
        label: period === "week" ? DIAS[d.getDay()] : String(d.getDate()),
        long: `${DIAS[d.getDay()]}, ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`,
        total: 0,
        days: new Set(),
      });
    }
    const map = Object.fromEntries(groups.map((g) => [g.key, g]));
    meals.forEach((x) => {
      const d = new Date(x.eaten_at);
      const g = map[dayKey(d)];
      if (g) {
        g.total += Number(x.total_kcal);
        g.days.add(g.key);
      }
    });
  }

  const total = groups.reduce((s, g) => s + g.total, 0);
  const daysLogged = new Set(meals.map((x) => dayKey(new Date(x.eaten_at)))).size;
  const avg = daysLogged ? total / daysLogged : 0;
  const tmb = profile?.tmb || 0;

  $("#report-stats").innerHTML = `
    <div class="stat"><b>${fmt(total)}</b><span>kcal no período</span></div>
    <div class="stat"><b>${fmt(avg)}</b><span>média por dia registrado</span></div>
    <div class="stat"><b>${daysLogged}</b><span>dias com registro</span></div>`;

  // gráfico de barras
  const max = Math.max(1, ...groups.map((g) => g.total), period === "year" ? 0 : tmb);
  const refDaily = period !== "year";
  $("#report-chart").innerHTML = groups
    .map((g) => {
      const h = (g.total / max) * 100;
      const over = refDaily && tmb && g.total > tmb;
      const showLabel = period !== "month" || g.label % 5 === 0 || g.label === "1";
      return `<div class="col" title="${esc(g.long || g.label)}: ${fmt(g.total)} kcal">
        ${period === "week" || period === "year" ? `<div class="v">${g.total ? fmt(g.total) : ""}</div>` : ""}
        <div class="b ${over ? "over" : ""}" style="height:${h}%"></div>
        <div class="l">${showLabel ? g.label : "&nbsp;"}</div></div>`;
    })
    .join("");

  // lista de detalhe
  const rows = groups.filter((g) => g.total > 0).reverse();
  if (!rows.length) {
    $("#report-list").innerHTML = '<div class="empty">Sem registros neste período.</div>';
    return;
  }
  $("#report-list").innerHTML = rows
    .map((g) => {
      let note = "";
      if (period === "year") {
        const dl = g.days.size;
        note = `${dl} dias · média ${fmt(g.total / dl)} kcal/dia`;
      } else if (tmb) {
        const diff = g.total - tmb;
        note = diff > 0 ? `${fmt(diff)} acima da TMB` : `${fmt(-diff)} abaixo da TMB`;
      }
      const click = period !== "year";
      return `<div class="item${click ? " clickable" : ""}" ${click ? `data-key="${g.key}"` : ""}><div><div class="d"><b>${esc(g.long || g.label)}</b></div><div class="t">${note}</div>${click ? '<div class="go">Toque para ver e editar ›</div>' : ""}</div><div class="k">${fmt(g.total)} kcal</div></div>`;
    })
    .join("");
  $$("#report-list .item.clickable").forEach((el) => el.addEventListener("click", () => showDay(el.dataset.key)));
}


// ---------- editar dias anteriores ----------
const toLocalInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
let openDay = null; // "YYYY-MM-DD" do dia aberto no detalhe

function refreshViews() {
  loadToday();
  if (!$("#tab-reports").hidden) loadReport();
  if (openDay) showDay(openDay);
}

async function showDay(key) {
  openDay = key;
  $("#day-date").value = key;
  const [y, m, d] = key.split("-").map(Number);
  const from = new Date(y, m - 1, d);
  $("#day-title").textContent = `${DIAS[from.getDay()]}, ${pad(d)}/${pad(m)}/${y}`;
  const list = $("#day-list");
  let meals = [];
  try {
    meals = await fetchMeals(from, addDays(from, 1));
  } catch (e) {
    list.innerHTML = `<div class="empty">Erro: ${esc(e.message)}</div>`;
    $("#day-modal").hidden = false;
    return;
  }
  const total = meals.reduce((s, x) => s + Number(x.total_kcal), 0);
  $("#day-title").textContent += ` · ${fmt(total)} kcal`;
  list.innerHTML = meals.length
    ? meals
        .map(
          (x) => `<div class="item"><div>
        <div class="t">${hhmm(x.eaten_at)}</div>
        <div class="d">${(x.items || []).map((i) => `${esc(i.name)} <small>${i.grams}g · ${i.kcal} kcal</small>`).join("<br>") || esc(x.description)}</div>
        <button class="edit" data-id="${x.id}">Editar</button> <button class="del" data-id="${x.id}">Excluir</button>
      </div><div class="k">${fmt(x.total_kcal)} kcal</div></div>`
        )
        .join("")
    : '<div class="empty">Nenhuma refeição neste dia.</div>';
  $$("#day-list .edit").forEach((b) =>
    b.addEventListener("click", () => {
      const x = meals.find((r) => String(r.id) === b.dataset.id);
      if (!x) return;
      const items = (x.items || []).map((i) => ({ ...i }));
      if (!items.length) items.push({ name: x.description || "", grams: 100, kcal: x.total_kcal || 0, protein_g: 0, carbs_g: 0, fat_g: 0, estimated: false });
      pending = { id: x.id, text: "", items, total: x.total_kcal, eaten_at: x.eaten_at };
      openModal();
    })
  );
  $$("#day-list .del").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("Excluir esta refeição do diário?")) return;
      const { error } = await sb.from("meals").delete().eq("id", b.dataset.id);
      if (error) return alert("Erro ao excluir: " + error.message);
      refreshViews();
    })
  );
  $("#day-modal").hidden = false;
}

function newMealAt(date) {
  pending = { text: "", items: [{ name: "", grams: 100, kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, estimated: false }], total: 0, eaten_at: date.toISOString() };
  openModal();
}
$("#day-date").addEventListener("change", (e) => {
  if (e.target.value) showDay(e.target.value);
});
$("#day-close").addEventListener("click", () => {
  openDay = null;
  $("#day-modal").hidden = true;
  if (!$("#tab-reports").hidden) loadReport();
});
$("#day-add").addEventListener("click", () => {
  const [y, m, d] = openDay.split("-").map(Number);
  const now = new Date();
  newMealAt(new Date(y, m - 1, d, now.getHours(), now.getMinutes()));
});
$("#btn-add-other").addEventListener("click", () => {
  const d = addDays(new Date(), -1); // começa em ontem; dá para trocar o dia no campo de data
  showDay(dayKey(d));
});

// ---------- início ----------
(async function init() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  const { data } = await sb.auth.getSession();
  if (!data.session) showScreen("s-auth");
  // se houver sessão, onAuthStateChange (INITIAL_SESSION) cuida do resto
})();


// ---------- atalho na tela inicial do celular ----------
(function () {
  const btns = $$(".install");
  const tips = $$(".install-tip");
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  if (standalone || !btns.length) return; // já está instalado
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  let deferred = null;
  const show = () => btns.forEach((b) => (b.hidden = false));
  const hide = () => {
    btns.forEach((b) => (b.hidden = true));
    tips.forEach((t) => (t.hidden = true));
  };
  const tipText = (t) => tips.forEach((p) => { p.textContent = t; p.hidden = false; });

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e;
    show();
  });
  window.addEventListener("appinstalled", hide);

  if (isIOS) show(); // iPhone não tem botão automático: mostramos o passo a passo ao tocar

  btns.forEach((b) =>
    b.addEventListener("click", async () => {
      if (deferred) {
        deferred.prompt();
        await deferred.userChoice.catch(() => {});
        deferred = null;
        hide();
      } else if (isIOS) {
        tipText("No iPhone, abra no Safari, toque em Compartilhar (quadrado com seta) e depois em “Adicionar à Tela de Início”.");
      } else {
        tipText("Toque nos 3 pontinhos do navegador (⋮) e escolha “Instalar app” ou “Adicionar à tela inicial”.");
      }
    })
  );

  // Se o navegador não ofereceu a instalação em alguns segundos (ex.: Firefox, Chrome sem suporte), ainda mostramos o botão com instruções.
  setTimeout(() => { if (!deferred && btns[0].hidden) show(); }, 4000);
})();
