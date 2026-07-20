# Panduan Penggunaan Linmas

Linmas adalah toolkit review keamanan defensif Codex-first untuk software yang dibantu AI. Linmas menyediakan CLI, sebelas skill keamanan bernamespace, evaluasi policy deterministik, bukti Proof Chain portabel, dan native MCP server untuk Codex. Skill Linmas juga dapat digunakan oleh AI coding agent lain sesuai tingkat kompatibilitas yang dijelaskan di bawah. Human review tetap wajib untuk setiap hasil.

## Persyaratan

- Node.js 24 atau lebih baru untuk CLI, source checkout, dan runtime MCP lokal.
- Git untuk instalasi dari source dan marketplace Codex.
- Codex CLI atau Codex desktop/app-server untuk jalur plugin Codex.
- Claude Code hanya jika menggunakan jalur managed skill Claude yang sudah diverifikasi.

Linmas tidak meminta API key OpenAI untuk penggunaan Codex berbasis subscription. Autentikasi provider tetap dikelola Codex. Live review bersifat opt-in dan memerlukan konfirmasi eksplisit sebelum input keluar dari komputer.

## Pilih jalur instalasi

| Jalur | Cocok untuk | Yang dipasang |
| --- | --- | --- |
| Source GitHub | Kontributor, development lokal reproducible, dan demo offline | Repository beserta script development |
| npm | Menjalankan CLI Linmas tanpa clone repository | Package dan CLI `linmas` yang dipublish |
| Codex marketplace | Menggunakan skill dan MCP tool Linmas di Codex | Plugin siap pakai `linmas@linmas` |
| Managed skill Claude Code | Menggunakan sebelas skill Linmas di Claude Code | Skill yang dipasang melalui CLI Linmas |

Package npm dan marketplace Codex adalah dua jalur distribusi terpisah. Instalasi package npm tidak otomatis mendaftarkan marketplace Codex, dan instalasi plugin Codex tidak otomatis menambahkan package ke project Node.js lain.

## Kompatibilitas AI agent

Codex adalah integrasi native utama dan jalur referensi untuk OpenAI Build Week 2026. Linmas tetap compatible dengan agent lain melalui managed installation yang diverifikasi atau instruksi Markdown portabel:

| AI agent atau surface | Tingkat kompatibilitas | Surface Linmas yang tersedia |
| --- | --- | --- |
| Codex | **Utama / native** | Plugin Git marketplace, sebelas skill, enam native MCP tool, managed skill directory, dan review melalui provider Codex. |
| Claude Code | **Compatible dan terverifikasi** | Managed installation sebelas skill dan review melalui provider Claude API. Registrasi native Linmas MCP plugin untuk Claude Code tidak diklaim. |
| Gemini CLI dan AI coding agent lain | **Portabel / manual** | Import atau adaptasi instruksi `skills/linmas-*/SKILL.md` jika agent mendukung project instruction atau user instruction yang setara. Belum ada installer, provider adapter, registrasi MCP, atau klaim parity khusus Gemini. |

Kompatibilitas portabel mencakup isi instruksi defensif, bukan instalasi otomatis atau perilaku runtime yang identik. Human review, otorisasi, dan safety boundary Linmas tetap berlaku pada setiap host.

## Instalasi dari GitHub

Clone repository publik lalu jalankan demo offline deterministik:

```bash
git clone https://github.com/TanKimGwan/linmas.git
cd linmas
npm ci
npm run demo:judge
```

Demo tersebut adalah replay fixture offline. Tidak melakukan model call dan tidak membutuhkan credential provider.

Agar CLI tersedia sebagai perintah `linmas` di komputer lokal:

```bash
npm link
linmas list
```

Jika tidak ingin membuat global link, jalankan entry point secara langsung:

```bash
node bin/linmas.mjs list
node bin/linmas.mjs review --skill linmas-secure-code-reviewer --input patch.diff
```

## Instalasi dari npm

Untuk instalasi CLI global:

```bash
npm install --global linmas@0.5.3
linmas list
```

Untuk menjalankan sekali tanpa instalasi global:

```bash
npx --yes linmas@0.5.3 list
npx --yes linmas@0.5.3 review --skill linmas-secure-code-reviewer --input patch.diff
```

Untuk dependency lokal project:

```bash
npm install --save-dev linmas@0.5.3
npx linmas list
```

Package npm berisi runtime canonical, skill, policy, contoh, dan source MCP. Package ini sengaja tidak mendaftarkan marketplace ke konfigurasi Codex. Untuk itu gunakan instalasi Codex marketplace di bawah.

## Instalasi sebagai plugin Codex

Tambahkan Git marketplace publik sekali, lalu pasang plugin:

```bash
codex plugin marketplace add TanKimGwan/linmas --ref main
codex plugin add linmas@linmas
codex plugin list
```

### Penting: marketplace berlaku per perangkat

Ini adalah **marketplace repository GitHub publik**, bukan entri pada katalog global Plugins Directory Codex/ChatGPT. Konfigurasi marketplace disimpan secara lokal di setiap komputer. Karena itu, Linmas yang sudah terpasang di satu komputer tidak otomatis muncul pada komputer lain atau pada pencarian katalog global.

Pada setiap komputer yang akan menggunakan Linmas, jalankan:

```bash
codex plugin marketplace add TanKimGwan/linmas --ref v0.5.3
codex plugin add linmas@linmas
codex plugin list
```

Setelah itu, tutup Codex sepenuhnya, buka kembali, lalu buat task baru. Jika plugin belum muncul, pastikan komputer tersebut memiliki Git, Node.js 24+, dan akses jaringan ke GitHub. Publikasi ke Plugins Directory resmi adalah proses terpisah yang memerlukan submission, review, dan approval OpenAI. Publikasi di GitHub dan npm tidak otomatis membuat Linmas muncul di katalog global tersebut.

Untuk release immutable yang reproducible, gunakan ref `v0.5.3`:

```bash
codex plugin marketplace add TanKimGwan/linmas --ref v0.5.3
codex plugin add linmas@linmas
```

Setelah instalasi atau upgrade, restart Codex desktop/app-server dan buat task baru. App-server lama dapat mempertahankan child process MCP dari cache plugin sebelumnya.

Plugin menyediakan sebelas skill:

- `linmas-security-domain-router`
- `linmas-secure-code-reviewer`
- `linmas-cloud-hardening-architect`
- `linmas-controls-compliance-reviewer`
- `linmas-detection-rules-engineer`
- `linmas-exploit-validation-specialist`
- `linmas-incident-triage-lead`
- `linmas-secure-systems-architect`
- `linmas-security-operations-lead`
- `linmas-smart-contract-reviewer`
- `linmas-threat-research-analyst`

Native MCP server menyediakan tepat enam tool:

| Tool | Perilaku |
| --- | --- |
| `linmas_review_prepare` | Persiapan offline; tidak memanggil provider dan tidak menulis file. |
| `linmas_review_compare` | Perbandingan offline dua capsule tervalidasi. |
| `linmas_policy_evaluate` | Evaluasi policy lokal deterministik. |
| `linmas_proof_verify` | Verifikasi proof bundle offline. |
| `linmas_proof_create` | Write lokal hanya dengan `confirm_write=true`. |
| `linmas_review_execute` | Transmisi ke provider hanya dengan `confirm_transmission=true`. |

Untuk upgrade instalasi marketplace yang sudah ada:

```bash
codex plugin marketplace upgrade linmas
codex plugin add linmas@linmas
```

Untuk menghapusnya:

```bash
codex plugin remove linmas@linmas
codex plugin marketplace remove linmas
```

Ini adalah instalasi plugin marketplace Codex. Linmas tidak otomatis muncul di katalog plugin ChatGPT `@...`. Plugin/app ChatGPT adalah surface terpisah dan memerlukan ChatGPT App atau remote MCP yang di-host secara terpisah.

## Instalasi skill di Claude Code

Pasang seluruh sebelas managed skill dari package yang dipublish:

```bash
npx --yes linmas@0.5.3 detect
npx --yes linmas@0.5.3 install --all
```

Pilih `Claude` ketika prompt host interaktif muncul. Linmas menulis managed skill ke `~/.claude/skills` dan mencatat ownership pada `~/.claude/linmas-manifest.json`. Untuk memasang satu specialist saja:

```bash
npx --yes linmas@0.5.3 install linmas-secure-code-reviewer
```

Verifikasi managed installation:

```bash
npx --yes linmas@0.5.3 doctor
```

Live execution melalui provider Claude adalah surface opt-in yang terpisah. Jalur tersebut membutuhkan `ANTHROPIC_API_KEY`, model eksplisit melalui `LINMAS_EVAL_MODEL` atau CLI, serta konfirmasi sebelum input yang disebutkan keluar dari komputer. Instalasi skill tidak mentransmisikan data review.

## Menggunakan Linmas dengan Gemini atau AI coding agent lain

Linmas saat ini tidak mengubah konfigurasi Gemini atau agent lain yang belum terdaftar. Jika agent mendukung instruksi Markdown persisten atau direktori bergaya Agent Skills, Anda dapat mengimpor atau mengadaptasi file canonical yang relevan dari `skills/linmas-*/SKILL.md` secara manual.

Perlakukan jalur ini sebagai kompatibilitas instruksi portabel, bukan integrasi native yang sudah diverifikasi. Agent harus mempertahankan persyaratan otorisasi, evidence, consent, dan human review Linmas. Native provider execution dan enam MCP tool Codex tidak otomatis tersedia hanya dengan menyalin file skill.

## Menggunakan Linmas dari CLI

Siapkan review lokal tanpa mengirim data ke provider:

```bash
linmas review \
  --skill linmas-secure-code-reviewer \
  --input patch.diff
```

Jalankan demo judge deterministik:

```bash
npm run demo:judge
```

Bandingkan dua Review Capsule lokal:

```bash
linmas review compare before.json after.json
```

Buat dan verifikasi proof bundle yang memuat keputusan human reviewer:

```bash
linmas proof create review-capsule.json --bundle proof-bundle
linmas proof verify proof-bundle
```

Provider-backed review dipisahkan secara sengaja. Jalur ini memerlukan provider, model yang dipilih secara eksplisit bila diperlukan, dan acknowledgement `--yes` bahwa input keluar dari komputer:

```bash
linmas review \
  --skill linmas-secure-code-reviewer \
  --input patch.diff \
  --provider codex \
  --model gpt-5.6-sol \
  --policy baseline-appsec \
  --capsule review-capsule.json \
  --yes
```

Jangan gunakan live review dengan secret atau data yang tidak berwenang untuk ditransmisikan.

## Menggunakan Linmas di Codex

Setelah plugin dipasang dan task baru dimulai, minta Codex melakukan review defensif yang bounded. Contoh:

```text
Gunakan Linmas secure code review untuk menganalisis patch ini terhadap risiko SQL injection.
Review hanya patch yang diberikan, tulis evidence dan precondition, dan pertahankan hasil sebagai advisory.
Jangan menjalankan provider atau mengirim data sebelum saya memberikan konfirmasi eksplisit.
```

Untuk pertanyaan arsitektur:

```text
Gunakan Linmas security domain router, lalu specialist terbaik, untuk mereview trust boundary cloud ini.
Nyatakan asumsi, konteks yang masih kurang, dan deterministic checks. Human review tetap wajib.
```

MCP tool offline menjaga pekerjaan tetap lokal. Write dan transmisi provider memiliki consent gate eksplisit yang terpisah. Output tool tidak pernah mengklaim approval, certification, remediation, atau bukti bahwa software aman.

## Memilih dan menggunakan setiap skill

Di Codex, panggil skill menggunakan nama lengkap bernamespace, misalnya `linmas:linmas-secure-code-reviewer`. Pada managed skill Claude Code, skill yang sama biasanya muncul tanpa namespace plugin sebagai `linmas-secure-code-reviewer`. Untuk Gemini atau agent lain, cara memanggilnya bergantung pada mekanisme pemuatan instruksi Markdown yang diimpor manual; parity native tidak diklaim.

Setiap prompt pemula sebaiknya memuat empat hal:

1. nama skill yang tepat;
2. scope berwenang dan materi yang akan direview;
3. pertanyaan atau keputusan yang membutuhkan bantuan; dan
4. bentuk output serta safety boundary yang diharapkan.

Jangan tempel credential, token, private key, atau data yang tidak berwenang untuk dibagikan. Contoh di bawah bersifat advisory dan read-only. Ganti teks dalam tanda kurung siku dengan materi Anda sendiri yang sudah disanitasi dan memang boleh direview.

### 1. Security Domain Router

Gunakan `linmas-security-domain-router` ketika Anda belum tahu specialist yang tepat atau permintaan menyentuh beberapa domain keamanan.

**Contoh kasus:** Anda menambahkan file upload, object storage, dan malware scanning ke sebuah API, tetapi belum tahu harus memulai dari review kode, cloud, atau arsitektur.

```text
Gunakan `linmas:linmas-security-domain-router`.

Scope berwenang: ringkasan desain terlampir untuk fitur file upload baru kami.
Tentukan specialist Linmas yang harus mereview lebih dulu. Jelaskan alasannya, sebutkan satu skill alternatif jika scope berubah, dan tulis input yang masih perlu saya berikan.
Jangan mengubah file, menjalankan test, atau memanggil provider live.
```

**Hasil yang diharapkan:** satu skill terbaik, alasan pemilihan, satu alternatif yang relevan, dan konteks berikutnya yang perlu dikumpulkan.

### 2. Secure Code Reviewer

Gunakan `linmas-secure-code-reviewer` untuk kode aplikasi, API, autentikasi, otorisasi, input handling, dependency, dan panduan remediasi aman.

**Contoh kasus:** Sebuah route Express menyusun query SQL dari parameter request dan Anda ingin mereviewnya sebelum merge.

```text
Gunakan `linmas:linmas-secure-code-reviewer`.

Scope berwenang: hanya file `user-route.diff` yang terlampir.
Review alur data dari parameter HTTP ke query database, termasuk risiko injection, authorization, error handling, dan data minimization.
Kembalikan Scope and assumptions, Findings dengan evidence dan severity, Recommended deterministic checks, dan Safety boundary. Pisahkan Confirmed finding, Needs validation, dan Recommendation. Jangan mengeksploitasi endpoint atau mengubah patch.
```

**Hasil yang diharapkan:** finding berbasis evidence, remediasi praktis, dan test untuk memverifikasi perbaikan.

### 3. Cloud Hardening Architect

Gunakan `linmas-cloud-hardening-architect` untuk IAM AWS, Azure, atau GCP, batas akun, jaringan, workload identity, logging, encryption, dan cloud guardrail.

**Contoh kasus:** Tim berencana menjalankan API pada AWS ECS di belakang ALB dengan RDS dan S3.

```text
Gunakan `linmas:linmas-cloud-hardening-architect`.

Scope berwenang: arsitektur staging AWS terlampir yang mencakup internet-facing ALB, ECS, RDS, S3, dan IAM role yang tercantum.
Review identity boundary, public exposure, segmentation, secret, logging, encryption, blast radius, rollout, dan rollback. Tandai asumsi yang membutuhkan evidence akun atau region.
Kembalikan finding yang diprioritaskan dan deterministic validation checks. Jangan terhubung ke AWS atau mengubah resource cloud.
```

**Hasil yang diharapkan:** rencana hardening cloud terurut dengan gap evidence dan pemeriksaan rollout yang aman.

### 4. Controls Compliance Reviewer

Gunakan `linmas-controls-compliance-reviewer` untuk pemetaan kontrol SOC 2, ISO 27001, HIPAA, atau PCI-DSS, kecukupan evidence, audit readiness, dan perencanaan gap.

**Contoh kasus:** Anda memiliki dokumen policy MFA, export quarterly access review, dan catatan restore test backup untuk readiness review SOC 2.

```text
Gunakan `linmas:linmas-controls-compliance-reviewer`.

Scope berwenang: indeks evidence tersanitasi yang terlampir untuk periode readiness SOC 2 kami dari [tanggal mulai] sampai [tanggal selesai].
Petakan evidence yang tersedia ke kontrol terkait, bedakan dokumen yang hilang dari kontrol yang gagal, tentukan evidence owner dan metode verifikasi, lalu buat daftar gap yang diprioritaskan.
Jangan mengklaim certification atau compliance. Jangan mengarang atau mengubah evidence.
```

**Hasil yang diharapkan:** control map dan gap yang jujur berdasarkan evidence, bukan approval audit.

### 5. Detection Rules Engineer

Gunakan `linmas-detection-rules-engineer` untuk rule SIEM, kebutuhan telemetry, pemetaan ATT&CK, threat hunt, tuning alert, false positive, dan desain detection-as-code.

**Contoh kasus:** Anda ingin mendeteksi kegagalan sign-in berulang yang dilanjutkan dengan sign-in berhasil dari lokasi baru.

```text
Gunakan `linmas:linmas-detection-rules-engineer`.

Scope berwenang: schema authentication event tersanitasi dan lima sample event dari SIEM staging kami yang terlampir.
Rancang detection vendor-neutral untuk kegagalan berulang yang diikuti login berhasil dari lokasi baru. Nyatakan telemetry prerequisite, ATT&CK mapping, logika rule, kemungkinan aktivitas benign, field untuk tuning, validation fixture, alert owner, dan response path.
Jangan mengklaim coverage tanpa evidence dan jangan deploy rule.
```

**Hasil yang diharapkan:** logika detection yang dapat diuji, blind spot yang diketahui, dan promotion checklist.

### 6. Exploit Validation Specialist

Gunakan `linmas-exploit-validation-specialist` hanya untuk lab, staging, CTF, atau lingkungan riset yang mendapat otorisasi eksplisit dan membutuhkan validasi kelemahan secara terbatas.

**Contoh kasus:** Review internal mencurigai SSRF pada service staging terisolasi dan pemiliknya membutuhkan rencana validasi dengan dampak paling kecil.

```text
Gunakan `linmas:linmas-exploit-validation-specialist`.

Scope berwenang: service staging terisolasi `staging.example.invalid`, dimiliki tim kami, selama window yang disetujui [waktu]. Dugaan masalah adalah SSRF pada fitur URL preview.
Buat rencana validasi non-destruktif yang menyatakan hipotesis, batas proof minimum, precondition, evidence yang harus direkam, stop condition, remediasi, dan kriteria retest.
Jangan mengirim request, memberikan panduan persistence atau stealth, mengakses credential, atau mengeksekusi payload.
```

**Hasil yang diharapkan:** rencana validasi bounded; tidak ada interaksi target kecuali diotorisasi terpisah dan dijalankan melalui proses yang dikendalikan manusia.

### 7. Incident Triage Lead

Gunakan `linmas-incident-triage-lead` untuk klasifikasi security event aktif, preservasi evidence, perencanaan containment, koordinasi investigasi, recovery, dan tindak lanjut post-incident.

**Contoh kasus:** Scanner repository melaporkan bahwa sebuah token GitHub mungkin pernah masuk commit.

```text
Gunakan `linmas:linmas-incident-triage-lead`.

Scope berwenang: alert yang sudah disensor, timestamp commit, dan ringkasan access log repository kami yang terlampir. Perlakukan nilai credential sebagai secret dan jangan pernah menampilkannya kembali.
Buat initial severity assessment, timeline fact-versus-hypothesis, volatile evidence checklist, opsi containment beserta trade-off operasional, owner, communication cadence, dan langkah validasi berikutnya.
Jangan mencabut credential, menghapus history, menghubungi pihak luar, atau mengubah evidence.
```

**Hasil yang diharapkan:** rencana triage yang tenang, menjaga evidence, serta memiliki owner dan decision point yang jelas.

### 8. Secure Systems Architect

Gunakan `linmas-secure-systems-architect` untuk trust boundary lintas sistem, model identity dan authorization, data flow, multi-tenancy, control placement, dan secure failure mode.

**Contoh kasus:** Anda merancang SaaS multi-tenant dengan API, background worker, PostgreSQL, dan object storage.

```text
Gunakan `linmas:linmas-secure-systems-architect`.

Scope berwenang: arsitektur pra-implementasi terlampir untuk SaaS multi-tenant kami.
Petakan trust zone, identity, tenant context, alur data sensitif, privileged path, integrasi eksternal, dan failure mode. Identifikasi risiko arsitektur serta kontrol yang harus ada pada kode, infrastruktur, dan monitoring, lengkap dengan downstream owner dan deterministic checks.
Pertahankan hasil pada level design review; jangan implementasikan atau deploy perubahan.
```

**Hasil yang diharapkan:** architecture threat model yang mengubah trust assumption menjadi keputusan kontrol yang dapat diuji.

### 9. Security Operations Lead

Gunakan `linmas-security-operations-lead` untuk monitoring plan, operational hardening, alert ownership, escalation path, runbook, kesehatan telemetry, dan workflow vulnerability management.

**Contoh kasus:** Service pembayaran baru membutuhkan rencana operasi keamanan sebelum masuk production.

```text
Gunakan `linmas:linmas-security-operations-lead`.

Scope berwenang: deployment dan operations plan terlampir untuk service pembayaran baru kami.
Rancang kebutuhan minimum monitoring, log retention, hardening, escalation, dan recovery runbook. Untuk setiap alert yang disarankan, sebutkan signal, threshold, owner, response action, evidence requirement, dan langkah operasional yang aman untuk rollback.
Jangan mengubah infrastruktur, mengaktifkan alert, atau mengklaim monitoring coverage yang belum diuji.
```

**Hasil yang diharapkan:** runbook SecOps yang dapat dijalankan dengan owner dan response path untuk setiap alert.

### 10. Smart Contract Reviewer

Gunakan `linmas-smart-contract-reviewer` untuk review kode Solidity atau Web3 yang berwenang, analisis asset flow, protocol invariant, access control, external call, oracle assumption, dan keamanan upgrade.

**Contoh kasus:** Vault Solidity lokal memiliki fungsi withdrawal dan jalur admin upgrade yang perlu direview sebelum deployment.

```text
Gunakan `linmas:linmas-smart-contract-reviewer`.

Scope berwenang: commit [hash] dari kontrak Solidity terlampir pada project test lokal; tidak ada kontrak deployed atau live network dalam scope.
Review asset flow, state transition withdrawal, reentrancy, privileged role, initialization, upgrade, external call, dan protocol invariant. Kembalikan finding berbasis evidence, regression atau invariant test yang aman, remediasi, dan asumsi yang memerlukan validasi chain state.
Jangan mengirim transaksi, deploy exploit code, atau berinteraksi dengan live network.
```

**Hasil yang diharapkan:** review protocol risk secara read-only dengan validation test yang aman dan tanpa tindakan on-chain.

### 11. Threat Research Analyst

Gunakan `linmas-threat-research-analyst` untuk analisis IOC yang diberikan, campaign hypothesis, ATT&CK mapping, source confidence, intelligence brief, dan handoff berorientasi detection.

**Contoh kasus:** SOC Anda memiliki daftar domain, file hash, dan observasi email phishing yang sudah disanitasi dari kasus internal.

```text
Gunakan `linmas:linmas-threat-research-analyst`.

Scope berwenang: daftar IOC dan source note tersanitasi yang terlampir dari kasus phishing internal kami.
Normalisasikan indikator, pisahkan observation dari hypothesis, nilai source confidence dan umur indikator, petakan behavior yang didukung evidence ke ATT&CK, identifikasi benign lookalike, lalu buat bounded hunt lead dan handoff ke detection engineering.
Jangan query layanan eksternal, berinteraksi dengan infrastruktur, mengidentifikasi korban, atau membuat high-confidence attribution dari satu signal.
```

**Hasil yang diharapkan:** defensive intelligence brief dengan confidence score dan langkah berikutnya yang actionable tetapi tetap bounded.

## Verifikasi setelah instalasi

Periksa plugin dan versinya:

```bash
codex plugin list
```

Entry yang diharapkan:

```text
linmas@linmas  installed, enabled  0.5.3
```

Jika instalasi baru belum ter-discovery pada task berjalan, restart Codex desktop/app-server dan buat task baru. Lalu minta Codex menampilkan skill atau MCP tool Linmas.

## Troubleshooting

### `linmas@linmas` tidak ditemukan

Marketplace GitHub harus ditambahkan secara terpisah pada setiap komputer. Tambahkan atau refresh marketplace, lalu ulangi instalasi plugin:

```bash
codex plugin marketplace add TanKimGwan/linmas --ref main
codex plugin add linmas@linmas
```

Jika pencarian dilakukan dari Plugins Directory Codex, Linmas mungkin belum terlihat karena marketplace GitHub publik dan katalog global resmi merupakan dua jalur distribusi yang berbeda.

### Plugin terpasang tetapi skill atau MCP tool tidak muncul

Restart Codex desktop/app-server dan buat task baru. Child process app-server yang lama dapat masih memakai cache lama.

### npm melaporkan engine tidak didukung

Pasang Node.js 24 atau lebih baru, lalu periksa:

```bash
node --version
```

### ChatGPT tidak menemukan Linmas di katalog plugin

Hal itu memang diharapkan untuk release ini. Linmas saat ini adalah plugin Git marketplace Codex. Integrasi ChatGPT memerlukan ChatGPT App hosted atau remote MCP deployment terpisah.

## Dokumentasi terkait

- [Linmas Usage Guide — English](USAGE.md)
- [README](README.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](.github/SECURITY.md)
