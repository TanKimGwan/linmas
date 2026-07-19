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
npm install --global linmas@0.5.1
linmas list
```

Untuk menjalankan sekali tanpa instalasi global:

```bash
npx --yes linmas@0.5.1 list
npx --yes linmas@0.5.1 review --skill linmas-secure-code-reviewer --input patch.diff
```

Untuk dependency lokal project:

```bash
npm install --save-dev linmas@0.5.1
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

Untuk release immutable yang reproducible, gunakan ref `v0.5.1`:

```bash
codex plugin marketplace add TanKimGwan/linmas --ref v0.5.1
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
npx --yes linmas@0.5.1 detect
npx --yes linmas@0.5.1 install --all
```

Pilih `Claude` ketika prompt host interaktif muncul. Linmas menulis managed skill ke `~/.claude/skills` dan mencatat ownership pada `~/.claude/linmas-manifest.json`. Untuk memasang satu specialist saja:

```bash
npx --yes linmas@0.5.1 install linmas-secure-code-reviewer
```

Verifikasi managed installation:

```bash
npx --yes linmas@0.5.1 doctor
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

## Verifikasi setelah instalasi

Periksa plugin dan versinya:

```bash
codex plugin list
```

Entry yang diharapkan:

```text
linmas@linmas  installed, enabled  0.5.1
```

Jika instalasi baru belum ter-discovery pada task berjalan, restart Codex desktop/app-server dan buat task baru. Lalu minta Codex menampilkan skill atau MCP tool Linmas.

## Troubleshooting

### `linmas@linmas` tidak ditemukan

Tambahkan atau refresh marketplace, lalu ulangi instalasi plugin:

```bash
codex plugin marketplace add TanKimGwan/linmas --ref main
codex plugin add linmas@linmas
```

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
