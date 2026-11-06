import type { Language } from "@/lib/i18n";
import { SHOW_SPONSOR } from "@/lib/sponsor-flag";
import { SHOW_NEWSMAKER } from "@/lib/newsmaker-flag";

export interface LegalSection {
  heading: string;
  paragraphs: string[];
}

export interface LegalDocument {
  title: string;
  lastUpdatedLabel: string;
  lastUpdated: string;
  intro: string;
  sections: LegalSection[];
}

const LAST_UPDATED_EN = "April 25, 2026";
const LAST_UPDATED_ID = "25 April 2026";
const ACCOUNT_GUIDANCE_UPDATED_EN = "September 27, 2026";
const ACCOUNT_GUIDANCE_UPDATED_ID = "27 September 2026";
const CONTACT_EMAIL = SHOW_NEWSMAKER
  ? "support@newsmaker.id"
  : "support@tradepilot.id";

const PRIVACY_EN: LegalDocument = {
  title: "Privacy Policy",
  lastUpdatedLabel: "Last updated",
  lastUpdated: ACCOUNT_GUIDANCE_UPDATED_EN,
  intro:
    'This Privacy Policy describes how TradePilot.id ("we", "us", "our") collects, uses, and shares information when you use our application and related services (the "Service"). TradePilot.id is operated by Newsmaker.id.',
  sections: [
    {
      heading: "1. Information We Collect",
      paragraphs: [
        "Account information. When you register, we collect your email address, display name, hashed password, and a security question and answer used for password recovery.",
        "Usage information. We store the trading analyses you generate, the instruments and timeframes you select, your language preference, and any feedback you submit on analyses.",
        "Device and log information. If you opt in to push notifications, we store the push-subscription endpoint provided by your browser. We may log your IP address, user agent, and request metadata for security, abuse prevention, and rate limiting.",
        "Local storage. We use your browser's local storage to keep you signed in and to remember your theme and language preferences.",
      ],
    },
    {
      heading: "2. How We Use Information",
      paragraphs: [
        "To provide, operate, and maintain the Service, including authentication and account management.",
        "To generate AI-assisted market analyses based on the instruments and context you submit.",
        "To deliver in-app and push notifications you have subscribed to.",
        "To detect, prevent, and respond to fraud, abuse, and security incidents.",
        "To improve the Service and develop new features.",
      ],
    },
    {
      heading: "3. Third-Party Services",
      paragraphs: [
        "We share the inputs of each analysis with our AI provider (currently OpenAI) solely to generate the analysis you requested. We do not send your account credentials, security answers, or the full content of other users' data to the AI provider.",
        "We rely on third-party hosting and database providers to operate the Service. These providers process data on our behalf under appropriate confidentiality and security obligations.",
        "We do not sell your personal information.",
      ],
    },
    {
      heading: "4. Data Retention",
      paragraphs: [
        "Account data is retained for as long as your account is active. You can permanently delete your own account at any time from Profile > Privacy & Security > Delete Account inside the app, or by contacting us. Self-service deletion removes your account and every record tied to it (analyses, notifications, alerts, journal entries, push subscriptions, and similar) immediately. Aggregate or anonymized records that no longer identify you (for example, anonymized analytics events) may be retained, as may records we are legally required to keep for security or fraud-prevention purposes.",
      ],
    },
    {
      heading: "5. Your Rights",
      paragraphs: [
        "Depending on your jurisdiction, you may have the right to access, correct, delete, or restrict the processing of your personal data, and to object to certain processing. You may exercise these rights by contacting us at the address below.",
      ],
    },
    {
      heading: "6. Security",
      paragraphs: [
        "Passwords are stored using industry-standard one-way hashing. Communication with the Service is protected with HTTPS. We follow reasonable administrative and technical safeguards. No system is fully secure; you are responsible for keeping your credentials confidential and for choosing a strong password.",
      ],
    },
    {
      heading: "7. Children",
      paragraphs: [
        "The Service is not directed to individuals under 18. If we become aware that we have collected personal data from a minor, we will delete it as soon as reasonably possible.",
      ],
    },
    {
      heading: "8. International Transfers",
      paragraphs: [
        "Your data may be processed in countries other than the one in which you reside. Where required, we put in place appropriate safeguards for such transfers.",
      ],
    },
    {
      heading: "9. Changes to This Policy",
      paragraphs: [
        'We may update this Privacy Policy from time to time. The "Last updated" date above always reflects the latest version. Material changes will be communicated in-app before they take effect.',
      ],
    },
    {
      heading: "10. Contact Us",
      paragraphs: [
        `For any privacy question or request, contact us at ${CONTACT_EMAIL}.`,
      ],
    },
  ],
};

const PRIVACY_ID: LegalDocument = {
  title: "Kebijakan Privasi",
  lastUpdatedLabel: "Terakhir diperbarui",
  lastUpdated: ACCOUNT_GUIDANCE_UPDATED_ID,
  intro:
    'Kebijakan Privasi ini menjelaskan bagaimana TradePilot.id ("kami") mengumpulkan, menggunakan, dan membagikan informasi ketika Anda menggunakan aplikasi dan layanan terkait kami ("Layanan"). TradePilot.id dioperasikan oleh Newsmaker.id.',
  sections: [
    {
      heading: "1. Informasi yang Kami Kumpulkan",
      paragraphs: [
        "Informasi akun. Saat mendaftar, kami mengumpulkan alamat email, nama tampilan, kata sandi yang sudah di-hash, serta pertanyaan dan jawaban keamanan yang digunakan untuk pemulihan kata sandi.",
        "Informasi penggunaan. Kami menyimpan analisis trading yang Anda buat, instrumen dan timeframe yang Anda pilih, preferensi bahasa, serta feedback yang Anda kirimkan pada analisis.",
        "Informasi perangkat dan log. Jika Anda mengaktifkan notifikasi push, kami menyimpan endpoint langganan push yang diberikan oleh peramban Anda. Kami juga dapat mencatat alamat IP, user agent, dan metadata permintaan untuk keperluan keamanan, pencegahan penyalahgunaan, dan rate limiting.",
        "Local storage. Kami menggunakan local storage peramban Anda untuk menjaga sesi login serta mengingat preferensi tema dan bahasa Anda.",
      ],
    },
    {
      heading: "2. Bagaimana Kami Menggunakan Informasi",
      paragraphs: [
        "Untuk menyediakan, mengoperasikan, dan memelihara Layanan, termasuk autentikasi dan pengelolaan akun.",
        "Untuk menghasilkan analisis pasar berbantu AI berdasarkan instrumen dan konteks yang Anda kirimkan.",
        "Untuk mengirim notifikasi in-app dan push yang Anda langgani.",
        "Untuk mendeteksi, mencegah, dan menangani kecurangan, penyalahgunaan, dan insiden keamanan.",
        "Untuk meningkatkan Layanan dan mengembangkan fitur baru.",
      ],
    },
    {
      heading: "3. Layanan Pihak Ketiga",
      paragraphs: [
        "Kami membagikan input setiap analisis kepada penyedia AI kami (saat ini OpenAI) semata-mata untuk menghasilkan analisis yang Anda minta. Kami tidak mengirim kredensial akun, jawaban keamanan, atau konten lengkap milik pengguna lain ke penyedia AI.",
        "Kami menggunakan penyedia hosting dan database pihak ketiga untuk mengoperasikan Layanan. Penyedia tersebut memproses data atas nama kami dengan kewajiban kerahasiaan dan keamanan yang sesuai.",
        "Kami tidak menjual informasi pribadi Anda.",
      ],
    },
    {
      heading: "4. Penyimpanan Data",
      paragraphs: [
        "Data akun disimpan selama akun Anda aktif. Anda dapat menghapus akun Anda sendiri kapan saja melalui Profil > Privasi & Keamanan > Hapus Akun di dalam aplikasi, atau dengan menghubungi kami. Penghapusan mandiri langsung menghapus akun Anda beserta seluruh data yang terkait (analisis, notifikasi, alert, catatan jurnal, langganan push, dan sejenisnya). Data agregat atau anonim yang tidak lagi mengidentifikasi Anda (misalnya event analitik yang sudah dianonimkan) dapat tetap disimpan, begitu juga data yang wajib kami simpan secara hukum untuk keperluan keamanan atau pencegahan kecurangan.",
      ],
    },
    {
      heading: "5. Hak Anda",
      paragraphs: [
        "Tergantung yurisdiksi Anda, Anda berhak mengakses, mengoreksi, menghapus, atau membatasi pemrosesan data pribadi Anda, serta menolak pemrosesan tertentu. Anda dapat menggunakan hak tersebut dengan menghubungi kami pada alamat di bawah.",
      ],
    },
    {
      heading: "6. Keamanan",
      paragraphs: [
        "Kata sandi disimpan menggunakan hashing satu arah sesuai standar industri. Komunikasi dengan Layanan dilindungi HTTPS. Kami menerapkan pengamanan administratif dan teknis yang wajar. Tidak ada sistem yang sepenuhnya aman; Anda bertanggung jawab menjaga kerahasiaan kredensial dan memilih kata sandi yang kuat.",
      ],
    },
    {
      heading: "7. Anak di Bawah Umur",
      paragraphs: [
        "Layanan ini tidak ditujukan untuk individu di bawah usia 18 tahun. Jika kami mengetahui telah mengumpulkan data pribadi anak di bawah umur, kami akan menghapusnya sesegera mungkin.",
      ],
    },
    {
      heading: "8. Transfer Internasional",
      paragraphs: [
        "Data Anda dapat diproses di negara lain selain tempat tinggal Anda. Bila diperlukan, kami menerapkan pengaman yang sesuai untuk transfer tersebut.",
      ],
    },
    {
      heading: "9. Perubahan Kebijakan",
      paragraphs: [
        'Kami dapat memperbarui Kebijakan Privasi ini sewaktu-waktu. Tanggal "Terakhir diperbarui" di atas selalu mencerminkan versi terbaru. Perubahan material akan diumumkan di dalam aplikasi sebelum berlaku.',
      ],
    },
    {
      heading: "10. Hubungi Kami",
      paragraphs: [
        `Untuk setiap pertanyaan atau permintaan terkait privasi, hubungi kami di ${CONTACT_EMAIL}.`,
      ],
    },
  ],
};

const TERMS_EN: LegalDocument = {
  title: "Terms of Service",
  lastUpdatedLabel: "Last updated",
  lastUpdated: LAST_UPDATED_EN,
  intro:
    'These Terms of Service ("Terms") govern your access to and use of TradePilot.id (the "Service"), operated by Newsmaker.id. By creating an account, accessing, or using the Service, you agree to be bound by these Terms.',
  sections: [
    {
      heading: "1. Eligibility",
      paragraphs: [
        "You must be at least 18 years old and have the legal capacity to enter into a binding contract to use the Service. You may not use the Service if doing so would be prohibited by the laws of your country or region.",
      ],
    },
    {
      heading: "2. Your Account",
      paragraphs: [
        "You are responsible for maintaining the confidentiality of your credentials and for all activity that occurs under your account. Notify us immediately if you suspect any unauthorized access.",
      ],
    },
    {
      heading: "3. License to Use",
      paragraphs: [
        "Subject to these Terms, we grant you a limited, non-exclusive, non-transferable, revocable license to access and use the Service for your personal, non-commercial use.",
      ],
    },
    {
      heading: "4. Acceptable Use",
      paragraphs: [
        "You agree not to: (a) reverse-engineer, decompile, or scrape the Service; (b) use the Service to violate any law or third-party right; (c) attempt to interfere with the integrity, security, or proper functioning of the Service or other users; or (d) use automated systems to access the Service without our prior written consent.",
      ],
    },
    {
      heading: "5. Not Financial Advice",
      paragraphs: [
        "TradePilot.id is a decision-support tool. The analyses, signals, indicators, confidence ranges, suggested entries or exits, and any other content generated by the Service are provided for informational and educational purposes only. They are not, and must not be relied on as, financial, investment, accounting, legal, or tax advice, and are not a recommendation to buy, sell, or hold any financial instrument.",
      ],
    },
    {
      heading: "6. Trading Risk Disclosure",
      paragraphs: [
        "Trading in financial markets carries substantial risk and may result in the loss of all or part of your capital. Past performance is not indicative of future results. You are solely responsible for your trading decisions and outcomes. We are not a broker, dealer, investment adviser, or fiduciary, and we do not execute trades on your behalf.",
        ...(SHOW_SPONSOR
          ? [
              'Sponsorship disclosure. TradePilot.id is co-branded with SOLID PRIME, a mini-account product of PT Solid Gold Berjangka, a futures broker regulated by BAPPEBTI and a member of JFX & ICH. SOLID PRIME may be presented as a sponsor or referenced in calls-to-action within the Service. The sponsorship does not influence the editorial independence of our analyses, indicators, or any AI-generated content, and it is not a recommendation to open an account or trade with that broker. Any account-opening, deposits, withdrawals, and trade execution are handled exclusively by PT Solid Gold Berjangka under its own terms and risk disclosures; TradePilot.id is not a party to that relationship.',
            ]
          : []),
      ],
    },
    {
      heading: "7. AI-Generated Content",
      paragraphs: [
        "Analyses are produced with the help of artificial intelligence. AI systems can produce information that is inaccurate, incomplete, biased, or out of date. You must independently verify all information before acting on it.",
      ],
    },
    {
      heading: "8. Service Availability",
      paragraphs: [
        'The Service is provided on an "as is" and "as available" basis. We do not guarantee uninterrupted, error-free, or fully secure operation. We may modify, suspend, or discontinue the Service, in whole or in part, at any time and without prior notice.',
      ],
    },
    {
      heading: "9. Intellectual Property",
      paragraphs: [
        "We and our licensors retain all rights, title, and interest in and to the Service, including its brand, software, design, and any content we create. You retain ownership of any content you submit, but you grant us the limited license described in the next section.",
      ],
    },
    {
      heading: "10. User Feedback",
      paragraphs: [
        "When you submit feedback or ratings on analyses, you grant us a worldwide, royalty-free, perpetual, irrevocable, sublicensable, and transferable license to use, reproduce, modify, and exploit that feedback to operate, evaluate, and improve the Service.",
      ],
    },
    {
      heading: "11. Termination",
      paragraphs: [
        "You may stop using the Service at any time. We may suspend or terminate your access if you violate these Terms or use the Service in a manner that we reasonably believe causes risk to us or to other users. Sections that by their nature should survive termination will continue to apply.",
      ],
    },
    {
      heading: "12. Disclaimers & Limitation of Liability",
      paragraphs: [
        "To the maximum extent permitted by law, we disclaim all warranties, express or implied, including warranties of merchantability, fitness for a particular purpose, and non-infringement.",
        "To the maximum extent permitted by law, we will not be liable for any indirect, incidental, consequential, special, exemplary, or punitive damages, or for any loss of profits, revenue, data, or trading opportunities, arising out of or in connection with your use of the Service. Our total aggregate liability for any claim arising out of these Terms shall not exceed the greater of (a) the total fees you have paid us in the 12 months preceding the claim, or (b) USD 50.",
      ],
    },
    {
      heading: "13. Indemnification",
      paragraphs: [
        "You agree to indemnify, defend, and hold harmless TradePilot.id, Newsmaker.id, and our affiliates from and against any claims, damages, liabilities, and expenses arising out of your use of the Service, your content, or your violation of these Terms.",
      ],
    },
    {
      heading: "14. Governing Law",
      paragraphs: [
        "These Terms are governed by the laws of the Republic of Indonesia, without regard to its conflict-of-laws principles.",
      ],
    },
    {
      heading: "15. Dispute Resolution",
      paragraphs: [
        "Any dispute arising out of or relating to these Terms or the Service will first be attempted to be resolved through good-faith negotiation. Any unresolved dispute will be subject to the exclusive jurisdiction of the competent courts of Jakarta, Indonesia.",
      ],
    },
    {
      heading: "16. Changes to These Terms",
      paragraphs: [
        "We may update these Terms from time to time. Material changes will be announced in-app. Continued use of the Service after the changes take effect constitutes your acceptance of the updated Terms.",
      ],
    },
    {
      heading: "17. Contact",
      paragraphs: [
        `For any question about these Terms, contact us at ${CONTACT_EMAIL}.`,
      ],
    },
  ],
};

const TERMS_ID: LegalDocument = {
  title: "Syarat Layanan",
  lastUpdatedLabel: "Terakhir diperbarui",
  lastUpdated: LAST_UPDATED_ID,
  intro:
    'Syarat Layanan ini ("Syarat") mengatur akses dan penggunaan TradePilot.id ("Layanan"), yang dioperasikan oleh Newsmaker.id. Dengan membuat akun, mengakses, atau menggunakan Layanan, Anda setuju untuk terikat oleh Syarat ini.',
  sections: [
    {
      heading: "1. Kelayakan",
      paragraphs: [
        "Anda harus berusia minimal 18 tahun dan memiliki kapasitas hukum untuk membuat perjanjian yang mengikat agar dapat menggunakan Layanan. Anda tidak boleh menggunakan Layanan jika hal tersebut dilarang oleh hukum negara atau wilayah Anda.",
      ],
    },
    {
      heading: "2. Akun Anda",
      paragraphs: [
        "Anda bertanggung jawab menjaga kerahasiaan kredensial dan atas semua aktivitas yang terjadi pada akun Anda. Segera beri tahu kami jika Anda mencurigai adanya akses tanpa izin.",
      ],
    },
    {
      heading: "3. Lisensi Penggunaan",
      paragraphs: [
        "Sesuai Syarat ini, kami memberi Anda lisensi terbatas, non-eksklusif, tidak dapat dialihkan, dan dapat dicabut untuk mengakses dan menggunakan Layanan untuk keperluan pribadi yang non-komersial.",
      ],
    },
    {
      heading: "4. Penggunaan yang Diperbolehkan",
      paragraphs: [
        "Anda setuju untuk tidak: (a) merekayasa balik, mendekompilasi, atau melakukan scraping terhadap Layanan; (b) menggunakan Layanan untuk melanggar hukum atau hak pihak ketiga; (c) berusaha mengganggu integritas, keamanan, atau pengoperasian Layanan maupun pengguna lain; atau (d) menggunakan sistem otomatis untuk mengakses Layanan tanpa persetujuan tertulis dari kami.",
      ],
    },
    {
      heading: "5. Bukan Saran Keuangan",
      paragraphs: [
        "TradePilot.id adalah alat pendukung keputusan. Analisis, sinyal, indikator, rentang keyakinan, saran entry atau exit, dan konten lain yang dihasilkan oleh Layanan disediakan hanya untuk tujuan informasi dan edukasi. Konten tersebut bukan, dan tidak boleh dijadikan sandaran sebagai, saran keuangan, investasi, akuntansi, hukum, atau pajak, dan bukan rekomendasi untuk membeli, menjual, atau menahan instrumen keuangan apa pun.",
      ],
    },
    {
      heading: "6. Pengungkapan Risiko Trading",
      paragraphs: [
        "Trading di pasar keuangan memiliki risiko yang besar dan dapat mengakibatkan hilangnya seluruh atau sebagian modal Anda. Kinerja masa lalu bukan indikator hasil di masa depan. Anda sepenuhnya bertanggung jawab atas keputusan dan hasil trading Anda. Kami bukan broker, dealer, penasihat investasi, atau fidusia, dan kami tidak melakukan eksekusi trading atas nama Anda.",
        ...(SHOW_SPONSOR
          ? [
              "Pengungkapan sponsorship. TradePilot.id tampil bersama (co-brand) dengan SOLID PRIME, yaitu produk mini akun dari PT Solid Gold Berjangka, pialang berjangka yang diawasi BAPPEBTI dan terdaftar sebagai anggota JFX & ICH. SOLID PRIME dapat ditampilkan sebagai sponsor atau dirujuk dalam ajakan bertindak (call-to-action) di dalam Layanan. Sponsorship ini tidak memengaruhi independensi editorial atas analisis, indikator, maupun konten yang dihasilkan AI, dan bukan merupakan rekomendasi untuk membuka akun atau bertransaksi melalui pialang tersebut. Pembukaan akun, setoran, penarikan, dan eksekusi transaksi sepenuhnya ditangani oleh PT Solid Gold Berjangka berdasarkan syarat dan pengungkapan risikonya sendiri; TradePilot.id bukan pihak dalam hubungan tersebut.",
            ]
          : []),
      ],
    },
    {
      heading: "7. Konten yang Dihasilkan AI",
      paragraphs: [
        "Analisis dihasilkan dengan bantuan kecerdasan buatan. Sistem AI dapat menghasilkan informasi yang tidak akurat, tidak lengkap, bias, atau ketinggalan zaman. Anda wajib memverifikasi seluruh informasi secara mandiri sebelum bertindak atasnya.",
      ],
    },
    {
      heading: "8. Ketersediaan Layanan",
      paragraphs: [
        'Layanan disediakan "sebagaimana adanya" dan "sebagaimana tersedia". Kami tidak menjamin pengoperasian tanpa gangguan, bebas kesalahan, atau sepenuhnya aman. Kami dapat memodifikasi, menangguhkan, atau menghentikan Layanan, secara keseluruhan atau sebagian, kapan saja dan tanpa pemberitahuan sebelumnya.',
      ],
    },
    {
      heading: "9. Hak Kekayaan Intelektual",
      paragraphs: [
        "Kami dan pemberi lisensi kami memegang seluruh hak, kepemilikan, dan kepentingan atas Layanan, termasuk merek, perangkat lunak, desain, dan konten apa pun yang kami buat. Anda tetap memiliki konten yang Anda kirimkan, tetapi memberikan lisensi terbatas seperti dijelaskan pada bagian berikut.",
      ],
    },
    {
      heading: "10. Feedback Pengguna",
      paragraphs: [
        "Saat Anda mengirim feedback atau penilaian pada analisis, Anda memberi kami lisensi global, bebas royalti, abadi, tidak dapat dicabut, dapat disublisensikan, dan dapat dialihkan untuk menggunakan, mereproduksi, memodifikasi, dan memanfaatkan feedback tersebut guna mengoperasikan, mengevaluasi, dan meningkatkan Layanan.",
      ],
    },
    {
      heading: "11. Penghentian",
      paragraphs: [
        "Anda dapat berhenti menggunakan Layanan kapan saja. Kami dapat menangguhkan atau mengakhiri akses Anda jika Anda melanggar Syarat ini atau menggunakan Layanan dengan cara yang menurut kami secara wajar menimbulkan risiko bagi kami atau pengguna lain. Bagian-bagian yang sifatnya seharusnya tetap berlaku setelah penghentian akan terus berlaku.",
      ],
    },
    {
      heading: "12. Penafian & Pembatasan Tanggung Jawab",
      paragraphs: [
        "Sejauh diizinkan oleh hukum yang berlaku, kami menafikan semua jaminan, baik tersurat maupun tersirat, termasuk jaminan kelayakan jual, kesesuaian untuk tujuan tertentu, dan tidak adanya pelanggaran.",
        "Sejauh diizinkan oleh hukum yang berlaku, kami tidak bertanggung jawab atas kerugian tidak langsung, insidental, konsekuensial, khusus, eksemplar, atau punitif, atau atas hilangnya keuntungan, pendapatan, data, atau peluang trading yang timbul dari atau berkaitan dengan penggunaan Layanan oleh Anda. Total tanggung jawab agregat kami atas klaim apa pun yang timbul dari Syarat ini tidak akan melebihi yang lebih besar antara (a) total biaya yang Anda bayarkan kepada kami dalam 12 bulan terakhir, atau (b) USD 50.",
      ],
    },
    {
      heading: "13. Ganti Rugi",
      paragraphs: [
        "Anda setuju untuk memberikan ganti rugi, membela, dan membebaskan TradePilot.id, Newsmaker.id, dan afiliasinya dari setiap klaim, kerusakan, kewajiban, dan biaya yang timbul dari penggunaan Layanan oleh Anda, konten Anda, atau pelanggaran Anda atas Syarat ini.",
      ],
    },
    {
      heading: "14. Hukum yang Berlaku",
      paragraphs: [
        "Syarat ini diatur oleh hukum Republik Indonesia, tanpa memperhatikan prinsip pertentangan hukumnya.",
      ],
    },
    {
      heading: "15. Penyelesaian Sengketa",
      paragraphs: [
        "Setiap sengketa yang timbul dari atau berkaitan dengan Syarat ini atau Layanan akan terlebih dahulu diupayakan diselesaikan melalui musyawarah dengan iktikad baik. Sengketa yang tidak terselesaikan akan tunduk pada yurisdiksi eksklusif pengadilan yang berwenang di Jakarta, Indonesia.",
      ],
    },
    {
      heading: "16. Perubahan Syarat",
      paragraphs: [
        "Kami dapat memperbarui Syarat ini dari waktu ke waktu. Perubahan material akan diumumkan di dalam aplikasi. Penggunaan Layanan secara terus-menerus setelah perubahan berlaku merupakan persetujuan Anda atas Syarat yang diperbarui.",
      ],
    },
    {
      heading: "17. Kontak",
      paragraphs: [
        `Untuk setiap pertanyaan tentang Syarat ini, hubungi kami di ${CONTACT_EMAIL}.`,
      ],
    },
  ],
};

const SUPPORT_EN: LegalDocument = {
  title: "Support",
  lastUpdatedLabel: "Last updated",
  lastUpdated: ACCOUNT_GUIDANCE_UPDATED_EN,
  intro:
    "Need help with your TradePilot account, or have a question about how the app works? Here's how to reach us.",
  sections: [
    {
      heading: "1. Contact",
      paragraphs: [
        `For any support request, email us at ${CONTACT_EMAIL}. Please include your account email and a description of the issue so we can help as quickly as possible.`,
      ],
    },
    {
      heading: "2. Reporting an Account Problem",
      paragraphs: [
        "If you're locked out, notice suspicious activity, or something in the app isn't working as expected, email us with your account email, the device/browser you're using, and what you were trying to do when the problem occurred.",
      ],
    },
    {
      heading: "3. Requesting Data Access, Correction, or Deletion",
      paragraphs: [
        "You can permanently delete your own account at any time from Profile > Privacy & Security > Delete Account inside the app — see the Delete Account page for exactly what that removes. If you'd rather not delete your account but want to access, correct, or export your data, or if you can't sign in to delete it yourself, email us and we'll assist.",
      ],
    },
  ],
};

const SUPPORT_ID: LegalDocument = {
  title: "Bantuan",
  lastUpdatedLabel: "Terakhir diperbarui",
  lastUpdated: ACCOUNT_GUIDANCE_UPDATED_ID,
  intro:
    "Butuh bantuan terkait akun TradePilot, atau ada pertanyaan soal cara kerja aplikasi? Berikut cara menghubungi kami.",
  sections: [
    {
      heading: "1. Kontak",
      paragraphs: [
        `Untuk permintaan bantuan apa pun, kirim email ke ${CONTACT_EMAIL}. Sertakan email akun Anda dan deskripsi masalahnya supaya kami bisa membantu secepat mungkin.`,
      ],
    },
    {
      heading: "2. Melaporkan Masalah Akun",
      paragraphs: [
        "Jika Anda terkunci dari akun, melihat aktivitas mencurigakan, atau ada bagian aplikasi yang tidak berjalan semestinya, kirim email dengan email akun Anda, perangkat/browser yang dipakai, dan apa yang sedang Anda lakukan saat masalah terjadi.",
      ],
    },
    {
      heading: "3. Meminta Akses, Koreksi, atau Penghapusan Data",
      paragraphs: [
        "Anda dapat menghapus akun Anda sendiri kapan saja melalui Profil > Privasi & Keamanan > Hapus Akun di dalam aplikasi — lihat halaman Hapus Akun untuk detail data apa saja yang dihapus. Jika Anda tidak ingin menghapus akun tapi ingin mengakses, mengoreksi, atau mengekspor data Anda, atau tidak bisa login untuk menghapusnya sendiri, kirim email dan kami akan bantu.",
      ],
    },
  ],
};

const DELETE_ACCOUNT_EN: LegalDocument = {
  title: "Delete Account",
  lastUpdatedLabel: "Last updated",
  lastUpdated: ACCOUNT_GUIDANCE_UPDATED_EN,
  intro:
    "You're always free to permanently delete your TradePilot account. Here's exactly how, and what happens when you do.",
  sections: [
    {
      heading: "1. How to Delete Your Account",
      paragraphs: [
        "Sign in, go to Profile > Privacy & Security, and choose Delete Account. You'll be asked to confirm your current password and explicitly confirm the deletion. This is self-service and takes effect immediately — there is no waiting period.",
        `If you can't sign in, email us at ${CONTACT_EMAIL} from your account's email address and we'll verify and process the deletion for you.`,
      ],
    },
    {
      heading: "2. What Gets Deleted",
      paragraphs: [
        "Your profile (email, display name, password, security question), every analysis you've generated, notifications, price alerts, journal entries, watchlist, saved filters, push notification subscriptions (web and mobile), and your active sessions — all removed immediately and permanently. This cannot be undone.",
      ],
    },
    {
      heading: "3. What May Be Retained",
      paragraphs: [
        "Aggregate or anonymized records that no longer identify you (for example, anonymized analytics events) may remain. Records we are legally required to retain for security, audit, or fraud-prevention purposes may also be kept, independent of your account.",
      ],
    },
    {
      heading: "4. Prefer Not to Delete Everything?",
      paragraphs: [
        `If you only want to stop receiving certain notifications, you can adjust that in Profile > Notification Settings without deleting your account. For any other request — accessing, correcting, or exporting your data — email ${CONTACT_EMAIL}.`,
      ],
    },
  ],
};

const DELETE_ACCOUNT_ID: LegalDocument = {
  title: "Hapus Akun",
  lastUpdatedLabel: "Terakhir diperbarui",
  lastUpdated: ACCOUNT_GUIDANCE_UPDATED_ID,
  intro:
    "Anda selalu bebas menghapus akun TradePilot Anda secara permanen. Berikut caranya, dan apa yang terjadi setelahnya.",
  sections: [
    {
      heading: "1. Cara Menghapus Akun",
      paragraphs: [
        "Login, buka Profil > Privasi & Keamanan, lalu pilih Hapus Akun. Anda akan diminta memasukkan kata sandi saat ini dan mengonfirmasi penghapusan secara eksplisit. Proses ini mandiri (self-service) dan berlaku langsung — tidak ada masa tunggu.",
        `Jika Anda tidak bisa login, kirim email ke ${CONTACT_EMAIL} dari alamat email akun Anda dan kami akan memverifikasi serta memproses penghapusannya untuk Anda.`,
      ],
    },
    {
      heading: "2. Data yang Dihapus",
      paragraphs: [
        "Profil Anda (email, nama tampilan, kata sandi, pertanyaan keamanan), semua analisis yang pernah Anda buat, notifikasi, price alert, catatan jurnal, watchlist, filter tersimpan, langganan notifikasi push (web maupun mobile), dan sesi aktif Anda — semuanya dihapus langsung dan permanen. Tindakan ini tidak dapat dibatalkan.",
      ],
    },
    {
      heading: "3. Data yang Mungkin Dipertahankan",
      paragraphs: [
        "Data agregat atau anonim yang tidak lagi mengidentifikasi Anda (misalnya event analitik yang sudah dianonimkan) dapat tetap ada. Data yang wajib kami simpan secara hukum untuk keperluan keamanan, audit, atau pencegahan kecurangan juga dapat tetap disimpan, terlepas dari akun Anda.",
      ],
    },
    {
      heading: "4. Tidak Ingin Menghapus Semuanya?",
      paragraphs: [
        `Jika Anda hanya ingin berhenti menerima notifikasi tertentu, Anda bisa mengaturnya di Profil > Pengaturan Notifikasi tanpa menghapus akun. Untuk permintaan lain — mengakses, mengoreksi, atau mengekspor data Anda — kirim email ke ${CONTACT_EMAIL}.`,
      ],
    },
  ],
};

export type LegalKind = "privacy" | "terms" | "support" | "delete-account";

const documents: Record<LegalKind, Record<Language, LegalDocument>> = {
  privacy: { en: PRIVACY_EN, id: PRIVACY_ID },
  terms: { en: TERMS_EN, id: TERMS_ID },
  support: { en: SUPPORT_EN, id: SUPPORT_ID },
  "delete-account": { en: DELETE_ACCOUNT_EN, id: DELETE_ACCOUNT_ID },
};

export function getLegalDocument(
  kind: LegalKind,
  lang: Language,
): LegalDocument {
  return documents[kind][lang];
}
