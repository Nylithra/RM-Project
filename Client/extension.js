/**
 * Atölye / Laboratuvar Uzaktan Kontrol Sistemi - VS Code Eklentisi
 * ------------------------------------------------------------------
 * Tek bir eklenti içinde "Öğrenci" ve "Hoca" modlarını barındırır.
 * Mod geçişleri şifre korumalıdır (bkz. atolye.modeSwitchPassword).
 */

const vscode = require("vscode");
const { io } = require("socket.io-client");

/** @type {import('socket.io-client').Socket | null} */
let socket = null;

/** @type {vscode.StatusBarItem} */
let statusBarItem;

/** @type {vscode.WebviewPanel | null} */
let teacherPanel = null;

let currentWatchedStudentId = null;
let studentListCache = [];
let saveListenerDisposable = null;

function activate(context) {
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  context.subscriptions.push(statusBarItem);
  updateStatusBar(context);
  statusBarItem.show();

  context.subscriptions.push(
    vscode.commands.registerCommand("atolye.switchMode", () =>
      switchMode(context)
    ),
    vscode.commands.registerCommand("atolye.connect", () => connect(context)),
    vscode.commands.registerCommand("atolye.disconnect", () =>
      disconnectSocket(context)
    ),
    vscode.commands.registerCommand("atolye.openTeacherPanel", () =>
      openTeacherPanel(context)
    ),
    vscode.commands.registerCommand("atolye.showStatus", () =>
      showStatus(context)
    )
  );

  const config = vscode.workspace.getConfiguration("atolye");
  if (config.get("autoConnect")) {
    connect(context);
  }
}

/* =========================================================
   MOD YÖNETİMİ (ŞİFRE KORUMALI)
   ========================================================= */

function getMode(context) {
  return context.globalState.get("atolye.currentMode", "ogrenci");
}

async function setMode(context, mode) {
  await context.globalState.update("atolye.currentMode", mode);
  updateStatusBar(context);
}

function updateStatusBar(context) {
  const mode = getMode(context);
  const connected = !!(socket && socket.connected);
  const icon = mode === "hoca" ? "$(mortar-board)" : "$(person)";
  const connIcon = connected ? "$(check)" : "$(circle-slash)";
  statusBarItem.text = `${icon} Atölye: ${
    mode === "hoca" ? "Hoca" : "Öğrenci"
  } ${connIcon}`;
  statusBarItem.tooltip =
    "Mod değiştirmek veya durumu görmek için tıklayın (şifre gereklidir)";
  statusBarItem.command = "atolye.switchMode";
}

async function switchMode(context) {
  const config = vscode.workspace.getConfiguration("atolye");
  const correctPassword = config.get("modeSwitchPassword");

  const entered = await vscode.window.showInputBox({
    prompt: "🔒 Mod değiştirmek için şifreyi girin",
    password: true,
    ignoreFocusOut: true,
    placeHolder: "Şifre",
  });

  if (entered === undefined) return; // kullanıcı vazgeçti

  if (entered !== correctPassword) {
    vscode.window.showErrorMessage("❌ Yanlış şifre. Mod değiştirilemedi.");
    return;
  }

  const currentMode = getMode(context);
  const choice = await vscode.window.showQuickPick(
    [
      {
        label: "$(person) Öğrenci",
        value: "ogrenci",
        description:
          currentMode === "ogrenci" ? "(şu anki mod)" : "Sunucuya kod gönderir, hoca kontrolüne açıktır",
      },
      {
        label: "$(mortar-board) Hoca",
        value: "hoca",
        description:
          currentMode === "hoca" ? "(şu anki mod)" : "Öğrencileri izler ve kontrol eder",
      },
    ],
    { placeHolder: "Hangi moda geçmek istiyorsunuz?" }
  );

  if (!choice) return;

  disconnectSocket(context);
  await setMode(context, choice.value);
  vscode.window.showInformationMessage(`✅ Mod değiştirildi: ${choice.label.replace(/\$\([^)]+\)\s*/, "")}`);
  connect(context);
}

/* =========================================================
   BAĞLANTI YÖNETİMİ
   ========================================================= */

function connect(context) {
  disconnectSocket(context);

  const config = vscode.workspace.getConfiguration("atolye");
  const serverUrl = config.get("serverUrl");
  const mode = getMode(context);

  try {
    socket = io(serverUrl, {
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelay: 2000,
    });
  } catch (err) {
    vscode.window.showErrorMessage(`Sunucuya bağlanılamadı: ${err.message}`);
    return;
  }

  socket.on("connect", () => {
    updateStatusBar(context);
    if (mode === "ogrenci") {
      registerAsStudent(context);
    } else {
      registerAsTeacher();
    }
  });

  socket.on("disconnect", () => updateStatusBar(context));

  socket.on("connect_error", (err) => {
    vscode.window.showWarningMessage(
      `Atölye sunucusuna bağlanılamıyor: ${err.message}`
    );
    updateStatusBar(context);
  });

  if (mode === "ogrenci") {
    setupStudentListeners(context);
  } else {
    setupTeacherListeners(context);
  }
}

function disconnectSocket(context) {
  if (saveListenerDisposable) {
    saveListenerDisposable.dispose();
    saveListenerDisposable = null;
  }
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
  if (context) updateStatusBar(context);
}

/* =========================================================
   ÖĞRENCİ MODU
   ========================================================= */

function registerAsStudent(context) {
  const config = vscode.workspace.getConfiguration("atolye");
  let name = config.get("studentName");
  if (!name) {
    name = `Öğrenci-${Math.floor(Math.random() * 10000)}`;
  }
  socket.emit("register-student", { name });

  // Ctrl+S ile kaydedilen her belgeyi sunucuya gönder
  saveListenerDisposable = vscode.workspace.onDidSaveTextDocument((doc) => {
    if (!socket || !socket.connected) return;
    socket.emit("code-update", {
      code: doc.getText(),
      fileName: doc.fileName.split(/[\\/]/).pop(),
    });
  });
  context.subscriptions.push(saveListenerDisposable);
}

function setupStudentListeners(context) {
  socket.on("control-taken", () => {
    // 3 saniye süren, otomatik kapanan bildirim (Notification alanında)
    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "⚠️ ÖĞRETMEN KONTROLÜ AKTİF!",
        cancellable: false,
      },
      () => new Promise((resolve) => setTimeout(resolve, 3000))
    );
  });

  socket.on("control-released", () => {
    vscode.window.setStatusBarMessage("✅ Öğretmen kontrolü sona erdi.", 3000);
  });

  socket.on("code-push", async ({ code, fileName }) => {
    await applyCodeToActiveEditor(code, fileName);
  });
}

async function applyCodeToActiveEditor(code, fileName) {
  let editor = vscode.window.activeTextEditor;

  // Aktif editör yoksa veya gönderilen dosya adıyla eşleşmiyorsa, açık belgeler arasında ara
  if (!editor || (fileName && !editor.document.fileName.endsWith(fileName))) {
    const match = vscode.workspace.textDocuments.find((d) =>
      d.fileName.endsWith(fileName || "")
    );
    if (match) {
      editor = await vscode.window.showTextDocument(match);
    }
  }

  if (!editor) {
    vscode.window.showWarningMessage(
      "Hocanın gönderdiği kodu uygulayacak açık bir editör bulunamadı."
    );
    return;
  }

  const fullRange = new vscode.Range(
    editor.document.positionAt(0),
    editor.document.positionAt(editor.document.getText().length)
  );

  await editor.edit((editBuilder) => {
    editBuilder.replace(fullRange, code);
  });
}

/* =========================================================
   HOCA MODU
   ========================================================= */

function registerAsTeacher() {
  socket.emit("register-teacher");
}

function setupTeacherListeners(context) {
  socket.on("student-list", (list) => {
    studentListCache = list;
    postToPanel({ type: "student-list", payload: list });
  });

  socket.on("code-update", ({ studentId, studentName, code, fileName }) => {
    if (studentId === currentWatchedStudentId) {
      postToPanel({
        type: "code-update",
        payload: { code, fileName, studentName },
      });
    }
  });

  socket.on("student-disconnected", ({ studentId }) => {
    if (studentId === currentWatchedStudentId) {
      currentWatchedStudentId = null;
      postToPanel({ type: "watched-student-left" });
    }
  });
}

function openTeacherPanel(context) {
  const mode = getMode(context);
  if (mode !== "hoca") {
    vscode.window.showWarningMessage(
      "Hoca panelini açmak için önce Hoca moduna geçmelisiniz (Atölye: Mod Değiştir)."
    );
    return;
  }

  if (teacherPanel) {
    teacherPanel.reveal(vscode.ViewColumn.Beside);
    return;
  }

  teacherPanel = vscode.window.createWebviewPanel(
    "atolyeHocaPaneli",
    "Atölye - Hoca Paneli",
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  teacherPanel.webview.html = getTeacherPanelHtml();

  teacherPanel.onDidDispose(() => {
    teacherPanel = null;
    currentWatchedStudentId = null;
  });

  teacherPanel.webview.onDidReceiveMessage((message) => {
    switch (message.type) {
      case "ready":
        postToPanel({ type: "student-list", payload: studentListCache });
        break;
      case "watch-student":
        currentWatchedStudentId = message.studentId;
        break;
      case "take-control":
        if (socket) socket.emit("take-control", { studentId: message.studentId });
        break;
      case "release-control":
        if (socket)
          socket.emit("release-control", { studentId: message.studentId });
        break;
      case "send-code":
        if (socket) {
          socket.emit("send-code", {
            studentId: message.studentId,
            code: message.code,
            fileName: message.fileName,
          });
        }
        vscode.window.setStatusBarMessage("📤 Kod öğrenciye gönderildi.", 2000);
        break;
    }
  });
}

function postToPanel(message) {
  if (teacherPanel) {
    teacherPanel.webview.postMessage(message);
  }
}

function getTeacherPanelHtml() {
  const nonce = getNonce();
  return `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 12px;
    display: flex;
    height: 100vh;
    box-sizing: border-box;
    gap: 12px;
  }
  #sidebar {
    width: 220px;
    flex-shrink: 0;
    overflow-y: auto;
    border-right: 1px solid var(--vscode-panel-border);
    padding-right: 8px;
  }
  #main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  h3 { margin: 4px 0 10px 0; font-size: 13px; opacity: 0.8; }
  .student-item {
    padding: 6px 8px;
    border-radius: 4px;
    cursor: pointer;
    margin-bottom: 4px;
    font-size: 13px;
    display: flex;
    justify-content: space-between;
  }
  .student-item:hover { background: var(--vscode-list-hoverBackground); }
  .student-item.active { background: var(--vscode-list-activeSelectionBackground); }
  .badge {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 8px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }
  .toolbar { display: flex; gap: 8px; margin-bottom: 8px; }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    padding: 5px 10px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 12px;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  textarea {
    flex: 1;
    width: 100%;
    box-sizing: border-box;
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    border: 1px solid var(--vscode-panel-border);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 13px;
    padding: 8px;
    resize: none;
  }
  #liveCode { margin-bottom: 8px; }
  .section-label { font-size: 11px; opacity: 0.7; margin: 4px 0; }
  #emptyState { opacity: 0.6; font-size: 13px; padding-top: 40px; text-align: center; }
</style>
</head>
<body>
  <div id="sidebar">
    <h3>👥 Bağlı Öğrenciler</h3>
    <div id="studentList"></div>
  </div>
  <div id="main">
    <div id="emptyState">Soldan bir öğrenci seçin.</div>
    <div id="workArea" style="display:none; flex:1; flex-direction:column; min-height:0;">
      <div class="toolbar">
        <strong id="activeStudentName"></strong>
        <span style="flex:1"></span>
        <button id="takeControlBtn">🔒 Kontrolü Al</button>
        <button id="releaseControlBtn" disabled>🔓 Kontrolü Bırak</button>
        <button id="sendCodeBtn">📤 Kodu Gönder</button>
      </div>
      <div class="section-label">Canlı Kod (öğrenci ekranı - salt okunur)</div>
      <textarea id="liveCode" readonly style="height:35%"></textarea>
      <div class="section-label">Düzenleme / Yorum Alanı (gönderilecek kod)</div>
      <textarea id="editCode" style="flex:1"></textarea>
    </div>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  let students = [];
  let activeId = null;
  let controlledIds = new Set();
  let liveFileName = '';

  const studentListEl = document.getElementById('studentList');
  const emptyState = document.getElementById('emptyState');
  const workArea = document.getElementById('workArea');
  const activeStudentName = document.getElementById('activeStudentName');
  const liveCode = document.getElementById('liveCode');
  const editCode = document.getElementById('editCode');
  const takeControlBtn = document.getElementById('takeControlBtn');
  const releaseControlBtn = document.getElementById('releaseControlBtn');
  const sendCodeBtn = document.getElementById('sendCodeBtn');

  function renderStudentList() {
    studentListEl.innerHTML = '';
    if (students.length === 0) {
      studentListEl.innerHTML = '<div style="opacity:0.6;font-size:12px;">Henüz bağlı öğrenci yok.</div>';
      return;
    }
    for (const s of students) {
      const div = document.createElement('div');
      div.className = 'student-item' + (s.id === activeId ? ' active' : '');
      div.innerHTML = '<span>' + s.name + '</span>' +
        (s.controlled ? '<span class="badge">kontrol altında</span>' : '');
      div.addEventListener('click', () => selectStudent(s.id, s.name));
      studentListEl.appendChild(div);
    }
  }

  function selectStudent(id, name) {
    activeId = id;
    emptyState.style.display = 'none';
    workArea.style.display = 'flex';
    activeStudentName.textContent = name;
    liveCode.value = '';
    editCode.value = '';
    releaseControlBtn.disabled = !controlledIds.has(id);
    vscode.postMessage({ type: 'watch-student', studentId: id });
    renderStudentList();
  }

  takeControlBtn.addEventListener('click', () => {
    if (!activeId) return;
    controlledIds.add(activeId);
    releaseControlBtn.disabled = false;
    vscode.postMessage({ type: 'take-control', studentId: activeId });
  });

  releaseControlBtn.addEventListener('click', () => {
    if (!activeId) return;
    controlledIds.delete(activeId);
    releaseControlBtn.disabled = true;
    vscode.postMessage({ type: 'release-control', studentId: activeId });
  });

  sendCodeBtn.addEventListener('click', () => {
    if (!activeId) return;
    vscode.postMessage({
      type: 'send-code',
      studentId: activeId,
      code: editCode.value,
      fileName: liveFileName,
    });
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'student-list':
        students = msg.payload || [];
        renderStudentList();
        break;
      case 'code-update':
        if (msg.payload) {
          liveCode.value = msg.payload.code || '';
          liveFileName = msg.payload.fileName || '';
          // Düzenleme alanı boşsa canlı koddan başlat (öğretmen henüz yazmadıysa)
          if (!editCode.dataset.touched) {
            editCode.value = msg.payload.code || '';
          }
        }
        break;
      case 'watched-student-left':
        liveCode.value = '';
        break;
    }
  });

  editCode.addEventListener('input', () => {
    editCode.dataset.touched = 'true';
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

function getNonce() {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

/* =========================================================
   YARDIMCI
   ========================================================= */

function showStatus(context) {
  const mode = getMode(context);
  const connected = !!(socket && socket.connected);
  const config = vscode.workspace.getConfiguration("atolye");
  vscode.window.showInformationMessage(
    `Mod: ${mode === "hoca" ? "Hoca" : "Öğrenci"} | Bağlantı: ${
      connected ? "Bağlı ✅" : "Bağlı Değil ❌"
    } | Sunucu: ${config.get("serverUrl")}`
  );
}

function deactivate() {
  disconnectSocket(null);
  if (teacherPanel) teacherPanel.dispose();
}

module.exports = { activate, deactivate };
