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
        <button class="del" data-id="${m.id}">Excluir</button>
      </div>
      <div class="k">${fmt(m.total_kcal)} kcal</div>
    </div>`
    )
    .join("");
  $$("#meal-list .del").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("Excluir esta refeição do diário?")) return;
      const { error } = await sb.from("meals").delete().eq("id", b.dataset.id);
      if (error) setMsg($("#meal-msg"), error.message);
      else loadToday();
    })
  );
}

// ---------- voz ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let recording = false;
const micBtn = $("#btn-mic");
const micStatus = $("#mic-status");
const mealText = $("#meal-text");
const micDefault = micStatus.textContent;

if (!SR) {
  micBtn.disabled = true;
  micBtn.style.opacity = 0.4;
  micStatus.textContent = "Seu navegador não suporta reconhecimento de voz. Digite abaixo (ou use o microfone do teclado do celular).";
} else {
  rec = new SR();
  rec.lang = "pt-BR";
  rec.interimResults = true;
  rec.continuous = true;
  let base = "";
  rec.onstart = () => {
    recording = true;
    base = mealText.value ? mealText.value.trim() + " " : "";
    micBtn.classList.add("rec");
    micStatus.textContent = "Ouvindo... fale o alimento e o peso. Toque de novo para parar.";
  };
  rec.onresult = (e) => {
    let t = "";
    for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
    mealText.value = base + t;
  };
  rec.onerror = (e) => {
    const m = { "not-allowed": "Permita o uso do microfone no navegador.", "no-speech": "Não ouvi nada. Tente de novo." };
    setMsg($("#meal-msg"), m[e.error] || "Erro no microfone: " + e.error);
  };
  rec.onend = () => {
    recording = false;
    micBtn.classList.remove("rec");
    micStatus.textContent = micDefault;
    if (mealText.value.trim().length > 2) calculate(); // calcula assim que parar de falar
  };
  micBtn.addEventListener("click", () => {
    setMsg($("#meal-msg"), "");
    try {
      recording ? rec.stop() : rec.start();
    } catch (_) {}
  });
}

// ---------- calcular calorias ----------
$("#btn-calc").addEventListener("click", calculate);

async function calculate() {
  const text = mealText.value.trim();
  const msg = $("#meal-msg");
  if (text.length < 2) return setMsg(msg, "Fale ou digite o que você comeu.");
  const btn = $("#btn-calc");
  btn.disabled = true;
  btn.textContent = "Calculando...";
  setMsg(msg, "");
  try {
    const { data, error } = await sb.functions.invoke("parse-meal", { body: { text } });
    if (error) {
      let detail = error.message;
      try {
        const j = await error.context.json();
        if (j?.error) detail = j.error;
      } catch (_) {}
      throw new Error(detail);
    }
    if (data?.error) throw new Error(data.error);
    pending = { text, items: data.items, total: data.total_kcal };
    openModal();
  } catch (e) {
    setMsg(msg, e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Calcular calorias";
  }
}

function openModal() {
  $("#modal-text").textContent = `“${pending.text}”`;
  $("#modal-items").innerHTML = pending.items
    .map(
      (i) => `<div class="item"><div><div class="d"><b>${esc(i.name)}</b></div>
      <div class="t">${i.grams} g · P ${i.protein_g}g · C ${i.carbs_g}g · G ${i.fat_g}g${i.estimated ? " · peso estimado" : ""}</div></div>
      <div class="k">${i.kcal} kcal</div></div>`
    )
    .join("");
  $("#modal-total").textContent = fmt(pending.total);
  $("#modal").hidden = false;
}
$("#modal-cancel").addEventListener("click", () => {
  pending = null;
  $("#modal").hidden = true;
});
$("#modal-save").addEventListener("click", async () => {
  if (!pending) return;
  const btn = $("#modal-save");
  btn.disabled = true;
  const { error } = await sb.from("meals").insert({
    user_id: user.id,
    eaten_at: new Date().toISOString(),
    description: pending.text,
    total_kcal: pending.total,
    items: pending.items,
  });
  btn.disabled = false;
  if (error) return alert("Erro ao salvar: " + error.message);
  pending = null;
  $("#modal").hidden = true;
  mealText.value = "";
  setMsg($("#meal-msg"), "Refeição salva no diário ✔", true);
  loadToday();
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
      return `<div class="item"><div><div class="d"><b>${esc(g.long || g.label)}</b></div><div class="t">${note}</div></div><div class="k">${fmt(g.total)} kcal</div></div>`;
    })
    .join("");
}

// ---------- início ----------
(async function init() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  const { data } = await sb.auth.getSession();
  if (!data.session) showScreen("s-auth");
  // se houver sessão, onAuthStateChange (INITIAL_SESSION) cuida do resto
})();
