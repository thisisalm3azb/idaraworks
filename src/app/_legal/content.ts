/**
 * Terms of Service & Privacy Policy content (005B) — bilingual, structured
 * prose kept out of the UI message catalog (long-form legal text, not UI
 * strings). Every statement reflects the ACTUAL inspected services and data
 * flows of IdaraWorks; nothing invents a registered legal entity, office
 * address, certification, compliance claim, or support email.
 *
 * IMPORTANT: this is plain-language policy text, not legal advice and not
 * professionally reviewed. Owner/legal review is required before public
 * commercial launch (see the 005B report).
 */
export const LEGAL_EFFECTIVE_DATE = "2026-08-27";

export type LegalSection = { heading: string; paragraphs: string[] };
export type LegalDoc = {
  title: string;
  intro: string;
  sections: LegalSection[];
  /** "Last updated" label + the effective date, localized. */
  updatedLabel: string;
};

const en_terms: LegalDoc = {
  title: "Terms of Service",
  updatedLabel: "Last updated",
  intro:
    "These terms govern your use of IdaraWorks, an operating system that helps project-based small and medium businesses manage their work, team and money. By creating an account or using the service, you agree to these terms. This is plain-language policy text, not legal advice.",
  sections: [
    {
      heading: "The service and your business records",
      paragraphs: [
        "IdaraWorks is a software service (the “service”). It is a tool you use to run your own business — it is not a party to your commercial relationships and does not provide accounting, tax, legal or financial advice.",
        "The records you create in IdaraWorks — your customers, quotations, work, materials, invoices, payments and documents — are your business records. You are responsible for their accuracy, for how you use them, and for meeting your own legal, tax and regulatory obligations. IdaraWorks stores and organizes this information on your behalf; it does not verify it or act on it for you.",
      ],
    },
    {
      heading: "Your account and workspace",
      paragraphs: [
        "You need an account to use the service. You are responsible for keeping your sign-in credentials secure and for activity in your workspace. The person who creates a workspace becomes its owner; the owner controls who else can join and what they can do.",
        "You may invite other people to your workspace. Their access and permissions are determined by the role you assign them, not by how they sign in. You are responsible for the people you invite.",
      ],
    },
    {
      heading: "Acceptable use",
      paragraphs: [
        "Use the service lawfully. Do not use it to store or share unlawful content, to infringe others’ rights, to attempt to breach its security or access data that is not yours, or to disrupt the service for others.",
        "The service enforces tenant isolation: each workspace’s data is separated at the database level and is not accessible to other workspaces.",
      ],
    },
    {
      heading: "Availability and changes",
      paragraphs: [
        "We aim to keep the service available and reliable, but it is provided on an “as is” and “as available” basis without warranties of any kind. The service is under active development and features may change, be added, or be removed.",
        "We may update these terms as the service evolves. When we do, we will change the “last updated” date. Continued use after an update means you accept the revised terms.",
      ],
    },
    {
      heading: "Your data and ending your use",
      paragraphs: [
        "Your business records remain yours. You can export your data from within the service, and you can stop using the service at any time.",
        "IdaraWorks does not permanently delete your records automatically; records are archived, cancelled or voided rather than hard-deleted, so your history stays intact. Data-retention and account-closure procedures will be published as the service matures.",
      ],
    },
    {
      heading: "Liability",
      paragraphs: [
        "To the extent permitted by applicable law, IdaraWorks is not liable for indirect or consequential losses, or for decisions you make based on information in the service. You remain responsible for your own business.",
      ],
    },
  ],
};

const en_privacy: LegalDoc = {
  title: "Privacy Policy",
  updatedLabel: "Last updated",
  intro:
    "This policy explains what information IdaraWorks handles and how, based on how the service actually works today. It is plain-language text, not legal advice.",
  sections: [
    {
      heading: "Information you provide",
      paragraphs: [
        "Account information: when you register, we collect your email address, your name (if you provide it), and a password (stored only as a secure hash by our authentication provider — we never see it). If you sign in with Google, we receive your verified email and basic profile from Google to establish your identity; the sign-in method never changes your role or permissions.",
        "Workspace information: the business details and records you enter — such as your workspace name, country, logo, terminology preferences, customers, quotations, work, materials, invoices and payments. This is your business data, held on your behalf.",
      ],
    },
    {
      heading: "Information collected automatically",
      paragraphs: [
        "To keep your account secure and to operate the service, we record authentication events (such as sign-in, sign-up and password-reset attempts) together with the IP address and browser user-agent involved. For a failed sign-in, the email address entered is recorded to help detect abuse. We also keep an audit trail of changes made inside your workspace.",
        "IdaraWorks does not use third-party advertising or analytics trackers, and does not sell your data or share it for marketing.",
      ],
    },
    {
      heading: "How your information is used",
      paragraphs: [
        "We use your information only to provide and secure the service: to authenticate you, to store and organize your business records, to enforce permissions and tenant isolation, to send transactional messages you request (such as a workspace invitation or a password reset), and to detect and prevent abuse.",
        "Optional configuration assistance may use AI to help you set up your workspace from the answers you give. This assistance helps you configure your own setup — it never generates or modifies application code, database structure, or security rules, and it does not create business records or data on your behalf.",
      ],
    },
    {
      heading: "Where your information is processed",
      paragraphs: [
        "The service runs on established cloud infrastructure. Your database records and uploaded files (such as your logo) are stored with our hosted database and storage provider; the application is hosted on a cloud platform; transactional emails, when configured, are sent through an email delivery provider. These providers process data on our behalf to run the service.",
        "Data is stored on servers operated by these providers; the specific hosting region is configured for the deployment.",
      ],
    },
    {
      heading: "Sharing",
      paragraphs: [
        "Within your workspace, your records are visible to the members you invite, according to the roles and permissions you set. Financial figures are shown only to members whose role permits it.",
        "We share information with the infrastructure providers described above solely to operate the service, and we may disclose information if required by law. We do not otherwise share your data.",
      ],
    },
    {
      heading: "Your choices and rights",
      paragraphs: [
        "You can view and correct the information in your workspace, export your data, and stop using the service at any time. Records are archived, cancelled or voided rather than hard-deleted, preserving your history; retention and deletion procedures will be published as the service matures.",
        "For privacy questions about a workspace you belong to, contact the owner or administrator who manages it. A published contact channel for privacy requests will be provided before public launch.",
      ],
    },
    {
      heading: "Changes to this policy",
      paragraphs: [
        "We may update this policy as the service evolves and will change the “last updated” date when we do. Material changes will be reflected here.",
      ],
    },
  ],
};

const ar_terms: LegalDoc = {
  title: "شروط الخدمة",
  updatedLabel: "آخر تحديث",
  intro:
    "تحكم هذه الشروط استخدامك لـ IdaraWorks، وهو نظام تشغيل يساعد الأعمال الصغيرة والمتوسطة القائمة على العمل بالمشاريع على إدارة أعمالها وفريقها وأموالها. بإنشائك حساباً أو استخدامك الخدمة فإنك توافق على هذه الشروط. هذا نصّ سياسات بلغة مبسّطة، وليس استشارة قانونية.",
  sections: [
    {
      heading: "الخدمة وسجلات عملك",
      paragraphs: [
        "IdaraWorks خدمة برمجية (“الخدمة”)، وهي أداة تستخدمها لإدارة عملك الخاص — وليست طرفاً في علاقاتك التجارية ولا تقدّم استشارات محاسبية أو ضريبية أو قانونية أو مالية.",
        "السجلات التي تنشئها داخل IdaraWorks — عملاؤك وعروض أسعارك وأعمالك وموادك وفواتيرك ومدفوعاتك ومستنداتك — هي سجلات عملك أنت. أنت المسؤول عن دقّتها وعن كيفية استخدامها وعن الوفاء بالتزاماتك القانونية والضريبية والتنظيمية. تحفظ IdaraWorks هذه المعلومات وتنظّمها نيابةً عنك دون أن تتحقق منها أو تتصرّف بناءً عليها بدلاً منك.",
      ],
    },
    {
      heading: "حسابك ومساحة عملك",
      paragraphs: [
        "تحتاج إلى حساب لاستخدام الخدمة. أنت مسؤول عن الحفاظ على سرّية بيانات دخولك وعن النشاط داخل مساحة عملك. يصبح منشئ مساحة العمل مالكاً لها، ويتحكم المالك في من ينضمّ إليها وما يمكنه فعله.",
        "يمكنك دعوة أشخاص آخرين إلى مساحة عملك. تُحدَّد صلاحياتهم بحسب الدور الذي تسنده إليهم، لا بحسب طريقة تسجيل دخولهم. وأنت مسؤول عن الأشخاص الذين تدعوهم.",
      ],
    },
    {
      heading: "الاستخدام المقبول",
      paragraphs: [
        "استخدم الخدمة بشكل قانوني. لا تستخدمها لتخزين محتوى غير قانوني أو مشاركته، أو للتعدّي على حقوق الآخرين، أو لمحاولة اختراق أمنها أو الوصول إلى بيانات ليست لك، أو لتعطيل الخدمة على الآخرين.",
        "تفرض الخدمة عزلاً بين المستأجرين: تُفصَل بيانات كل مساحة عمل على مستوى قاعدة البيانات ولا يمكن لمساحات العمل الأخرى الوصول إليها.",
      ],
    },
    {
      heading: "التوافر والتغييرات",
      paragraphs: [
        "نسعى إلى إبقاء الخدمة متاحة وموثوقة، لكنها تُقدَّم “كما هي” و“حسب توافرها” دون أي ضمانات. الخدمة قيد التطوير المستمر وقد تتغيّر ميزاتها أو تُضاف أو تُزال.",
        "قد نحدّث هذه الشروط مع تطوّر الخدمة، وعندها نغيّر تاريخ “آخر تحديث”. ويعني استمرارك في الاستخدام بعد التحديث قبولك للشروط المعدّلة.",
      ],
    },
    {
      heading: "بياناتك وإنهاء استخدامك",
      paragraphs: [
        "تبقى سجلات عملك ملكاً لك. يمكنك تصدير بياناتك من داخل الخدمة والتوقف عن استخدامها في أي وقت.",
        "لا تحذف IdaraWorks سجلاتك نهائياً بشكل تلقائي؛ فالسجلات تُؤرشف أو تُلغى أو تُبطَل بدل الحذف النهائي، حفاظاً على تاريخك. وستُنشر إجراءات الاحتفاظ بالبيانات وإغلاق الحساب مع نضوج الخدمة.",
      ],
    },
    {
      heading: "المسؤولية",
      paragraphs: [
        "إلى الحد الذي يسمح به القانون المعمول به، لا تتحمّل IdaraWorks مسؤولية الخسائر غير المباشرة أو التبعية، ولا القرارات التي تتخذها بناءً على معلومات داخل الخدمة. وتبقى مسؤولاً عن عملك.",
      ],
    },
  ],
};

const ar_privacy: LegalDoc = {
  title: "سياسة الخصوصية",
  updatedLabel: "آخر تحديث",
  intro:
    "توضّح هذه السياسة المعلومات التي تتعامل معها IdaraWorks وكيفية ذلك، استناداً إلى طريقة عمل الخدمة فعلياً اليوم. وهي نصّ بلغة مبسّطة وليست استشارة قانونية.",
  sections: [
    {
      heading: "المعلومات التي تقدّمها",
      paragraphs: [
        "معلومات الحساب: عند التسجيل نجمع بريدك الإلكتروني واسمك (إن قدّمته) وكلمة مرور (تُحفَظ فقط كقيمة مشفّرة آمنة لدى مزوّد المصادقة — ولا نطّلع عليها إطلاقاً). إذا سجّلت الدخول عبر Google فإننا نستلم بريدك الموثّق وملفك الأساسي من Google لإثبات هويتك؛ ولا تغيّر طريقة تسجيل الدخول دورك أو صلاحياتك.",
        "معلومات مساحة العمل: تفاصيل عملك والسجلات التي تُدخلها — مثل اسم مساحة العمل والدولة والشعار وتفضيلات المصطلحات والعملاء وعروض الأسعار والأعمال والمواد والفواتير والمدفوعات. هذه بيانات عملك، محفوظة نيابةً عنك.",
      ],
    },
    {
      heading: "المعلومات المجمّعة تلقائياً",
      paragraphs: [
        "للحفاظ على أمان حسابك وتشغيل الخدمة نسجّل أحداث المصادقة (مثل تسجيل الدخول والتسجيل ومحاولات إعادة تعيين كلمة المرور) مع عنوان IP ونوع المتصفّح المستخدم. وعند فشل تسجيل الدخول يُسجَّل البريد المُدخَل للمساعدة على كشف إساءة الاستخدام. كما نحتفظ بسجلّ تدقيق للتغييرات داخل مساحة عملك.",
        "لا تستخدم IdaraWorks أدوات تتبّع إعلانية أو تحليلية من أطراف ثالثة، ولا تبيع بياناتك أو تشاركها لأغراض التسويق.",
      ],
    },
    {
      heading: "كيف تُستخدم معلوماتك",
      paragraphs: [
        "نستخدم معلوماتك فقط لتقديم الخدمة وتأمينها: للتحقق من هويتك، ولحفظ سجلات عملك وتنظيمها، ولفرض الصلاحيات والعزل بين المستأجرين، ولإرسال الرسائل المعامَلاتية التي تطلبها (مثل دعوة مساحة عمل أو إعادة تعيين كلمة مرور)، ولكشف إساءة الاستخدام ومنعها.",
        "قد تستعين مساعدة الإعداد الاختيارية بالذكاء الاصطناعي لمساعدتك على تهيئة مساحة عملك انطلاقاً من إجاباتك. تساعدك هذه الميزة على إعداد نظامك الخاص — ولا تولّد أو تعدّل شيفرة التطبيق أو بنية قاعدة البيانات أو قواعد الأمان، ولا تنشئ سجلات أو بيانات نيابةً عنك.",
      ],
    },
    {
      heading: "أين تُعالَج معلوماتك",
      paragraphs: [
        "تعمل الخدمة على بنية سحابية معتمدة. تُخزَّن سجلات قاعدة بياناتك وملفاتك المرفوعة (مثل شعارك) لدى مزوّد قاعدة البيانات والتخزين المستضاف؛ ويُستضاف التطبيق على منصة سحابية؛ وتُرسَل الرسائل المعامَلاتية — عند تفعيلها — عبر مزوّد لتوصيل البريد. يعالج هؤلاء المزوّدون البيانات نيابةً عنا لتشغيل الخدمة.",
        "تُخزَّن البيانات على خوادم يديرها هؤلاء المزوّدون، وتُضبَط منطقة الاستضافة المحدّدة حسب النشر.",
      ],
    },
    {
      heading: "المشاركة",
      paragraphs: [
        "داخل مساحة عملك، تكون سجلاتك مرئية للأعضاء الذين تدعوهم بحسب الأدوار والصلاحيات التي تحدّدها. وتُعرَض الأرقام المالية فقط للأعضاء الذين يسمح لهم دورهم بذلك.",
        "نشارك المعلومات مع مزوّدي البنية المذكورين أعلاه فقط لتشغيل الخدمة، وقد نفصح عنها إذا استلزم القانون ذلك. وبخلاف ذلك لا نشارك بياناتك.",
      ],
    },
    {
      heading: "خياراتك وحقوقك",
      paragraphs: [
        "يمكنك الاطلاع على معلومات مساحة عملك وتصحيحها، وتصدير بياناتك، والتوقف عن استخدام الخدمة في أي وقت. وتُؤرشف السجلات أو تُلغى أو تُبطَل بدل الحذف النهائي حفاظاً على تاريخك؛ وستُنشر إجراءات الاحتفاظ والحذف مع نضوج الخدمة.",
        "لأي أسئلة تتعلق بالخصوصية حول مساحة عمل تنتمي إليها، تواصل مع المالك أو المسؤول الذي يديرها. وستُوفَّر قناة تواصل معلنة لطلبات الخصوصية قبل الإطلاق العام.",
      ],
    },
    {
      heading: "التغييرات على هذه السياسة",
      paragraphs: [
        "قد نحدّث هذه السياسة مع تطوّر الخدمة، وسنغيّر تاريخ “آخر تحديث” عندها. وستنعكس التغييرات الجوهرية هنا.",
      ],
    },
  ],
};

export function legalDoc(kind: "terms" | "privacy", locale: "en" | "ar"): LegalDoc {
  if (kind === "terms") return locale === "ar" ? ar_terms : en_terms;
  return locale === "ar" ? ar_privacy : en_privacy;
}
