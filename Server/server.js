/**
 * Atölye / Laboratuvar Uzaktan Kontrol Sistemi - Merkezi Sunucu
 * ----------------------------------------------------------------
 * Bu sunucu, VS Code eklentisinin "öğrenci" ve "hoca" modları
 * arasındaki tüm gerçek zamanlı iletişimi yönetir.
 *
 * Ana kavramlar:
 *  - students: Map<socketId, StudentInfo>  -> Bağlı öğrenciler
 *  - teachers: Set<socketId>                -> Bağlı hocalar
 *
 * Olaylar (events):
 *   [Öğrenciden gelen]
 *     register-student   -> { name }
 *     code-update        -> { code, fileName }
 *     disconnect
 *
 *   [Hocadan gelen]
 *     register-teacher
 *     take-control        -> { studentId }
 *     release-control     -> { studentId }
 *     send-code           -> { studentId, code, fileName }
 *     disconnect
 *
 *   [Sunucudan öğrenciye]
 *     control-taken        (hoca kontrolü aldı -> uyarı göster)
 *     control-released      (hoca kontrolü bıraktı)
 *     code-push            -> { code, fileName } (hoca kodu gönderdi, uygula)
 *
 *   [Sunucudan hocaya]
 *     student-list          -> [{ id, name, fileName, controlled }]
 *     code-update            -> { studentId, code, fileName } (canlı izleme)
 *     student-disconnected  -> { studentId }
 */

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

// Basit bir sağlık kontrolü endpoint'i
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Atölye Kontrol Sunucusu",
    connectedStudents: students.size,
    connectedTeachers: teachers.size,
  });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Geliştirme için açık; prod'da kısıtlayın
    methods: ["GET", "POST"],
  },
});

/** @type {Map<string, {id: string, name: string, code: string, fileName: string, controlled: boolean, controlledBy: string|null}>} */
const students = new Map();

/** @type {Set<string>} */
const teachers = new Set();

function buildStudentList() {
  return Array.from(students.values()).map((s) => ({
    id: s.id,
    name: s.name,
    fileName: s.fileName,
    controlled: s.controlled,
  }));
}

function broadcastStudentListToTeachers() {
  const list = buildStudentList();
  for (const teacherSocketId of teachers) {
    io.to(teacherSocketId).emit("student-list", list);
  }
}

io.on("connection", (socket) => {
  console.log(`[+] Yeni bağlantı: ${socket.id}`);

  // ---------- ÖĞRENCİ TARAFI ----------
  socket.on("register-student", (payload = {}) => {
    const name = (payload.name || `Öğrenci-${socket.id.slice(0, 5)}`).trim();

    students.set(socket.id, {
      id: socket.id,
      name,
      code: "",
      fileName: "",
      controlled: false,
      controlledBy: null,
    });

    socket.join("students-room");
    console.log(`[Öğrenci] Kayıt oldu: ${name} (${socket.id})`);

    broadcastStudentListToTeachers();
  });

  socket.on("code-update", (payload = {}) => {
    const student = students.get(socket.id);
    if (!student) return; // Kayıtsız öğrenciden gelen veriyi yok say

    student.code = payload.code || "";
    student.fileName = payload.fileName || "";

    // İzleyen hocalara canlı olarak ilet
    for (const teacherSocketId of teachers) {
      io.to(teacherSocketId).emit("code-update", {
        studentId: socket.id,
        studentName: student.name,
        code: student.code,
        fileName: student.fileName,
      });
    }

    // Dosya adı değişmiş olabilir, listeyi güncelle
    broadcastStudentListToTeachers();
  });

  // ---------- HOCA TARAFI ----------
  socket.on("register-teacher", () => {
    teachers.add(socket.id);
    socket.join("teachers-room");
    console.log(`[Hoca] Kayıt oldu: ${socket.id}`);

    // Hocaya güncel öğrenci listesini gönder
    socket.emit("student-list", buildStudentList());
  });

  socket.on("take-control", (payload = {}) => {
    const { studentId } = payload;
    const student = students.get(studentId);
    if (!student) return;

    student.controlled = true;
    student.controlledBy = socket.id;

    io.to(studentId).emit("control-taken", {
      teacherId: socket.id,
    });

    broadcastStudentListToTeachers();
    console.log(`[Hoca ${socket.id}] kontrolü aldı: ${student.name}`);
  });

  socket.on("release-control", (payload = {}) => {
    const { studentId } = payload;
    const student = students.get(studentId);
    if (!student) return;

    student.controlled = false;
    student.controlledBy = null;

    io.to(studentId).emit("control-released");
    broadcastStudentListToTeachers();
  });

  socket.on("send-code", (payload = {}) => {
    const { studentId, code, fileName } = payload;
    const student = students.get(studentId);
    if (!student) return;

    // Hocanın gönderdiği kodu öğrenciye ilet
    io.to(studentId).emit("code-push", {
      code: code || "",
      fileName: fileName || student.fileName,
    });

    // Sunucudaki kopyayı da güncelle (tutarlılık için)
    student.code = code || "";
    console.log(`[Hoca ${socket.id}] kod gönderdi -> ${student.name}`);
  });

  socket.on("request-student-list", () => {
    socket.emit("student-list", buildStudentList());
  });

  // ---------- BAĞLANTI KOPTU ----------
  socket.on("disconnect", () => {
    if (students.has(socket.id)) {
      const student = students.get(socket.id);
      students.delete(socket.id);
      console.log(`[-] Öğrenci ayrıldı: ${student.name} (${socket.id})`);

      for (const teacherSocketId of teachers) {
        io.to(teacherSocketId).emit("student-disconnected", {
          studentId: socket.id,
        });
      }
      broadcastStudentListToTeachers();
    }

    if (teachers.has(socket.id)) {
      teachers.delete(socket.id);
      console.log(`[-] Hoca ayrıldı: ${socket.id}`);
    }
  });
});

server.listen(PORT, () => {
  console.log(`✅ Atölye Kontrol Sunucusu ${PORT} portunda çalışıyor.`);
});
