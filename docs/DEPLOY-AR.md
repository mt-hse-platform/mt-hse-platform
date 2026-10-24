# دليل النشر على Oracle Cloud (مجاني) — خطوة بخطوة

> الأوامر التي في صناديق الكود تُنسخ كما هي. استبدل ما بين `< >` بقيمك.
> واجهات Oracle تتغير أحيانًا؛ إن لم تجد زرًّا بالاسم المكتوب فابحث عن أقرب اسم له أو أرسل لي لقطة شاشة.

## 0) تنبيهات صريحة قبل البدء
1. **Oracle المجاني ليس مضمونًا.** قد يفشل التسجيل ببطاقة مصرية، وقد تظهر رسالة "Out of host capacity" عند إنشاء الجهاز. البديل: أي سيرفر Ubuntu 24.04 مدفوع صغير (تكلفته بضعة دولارات شهريًا) — كل الخطوات من القسم 6 فصاعدًا تنطبق عليه كما هي.
2. **الأجهزة المجانية قد تُوقَف إذا بدت "خاملة".** النظام قليل الاستخدام، فقد يقل استهلاك المعالج عن الحد الذي تعتبره Oracle خمولًا. الحل المضمون: ترقية الحساب إلى **Pay As You Go** (القسم 2). ما يبقى ضمن حدود Always Free لا يُحاسَب عليه.
3. حدود المجاني تتغير؛ راجع صفحة Oracle Always Free وقت التسجيل.

## 1) إنشاء حساب Oracle Cloud
1. افتح `https://www.oracle.com/cloud/free/` واضغط **Start for free**.
2. أدخل البريد والدولة (مصر) والاسم، ثم أكّد البريد من الرسالة.
3. اختر **Home Region** بعناية: **لا يمكن تغييرها لاحقًا**، والموارد المجانية تُنشأ فيها فقط. اختر منطقة قريبة وفيها سعة (مثل Frankfurt أو منطقة في الشرق الأوسط). إن فشل إنشاء الجهاز بسبب السعة فجرّب في وقت آخر.
4. أدخل بطاقة للتحقق (يُجرى خصم مؤقت صغير للتحقق ثم يُلغى) ورقم هاتفك.
5. انتظر رسالة تفعيل الحساب (دقائق إلى ساعات)، ثم ادخل من `https://cloud.oracle.com`.

## 2) ترقية الحساب (يمنع إيقاف الجهاز بسبب الخمول) + تنبيه تكلفة
1. من القائمة ☰ ← **Billing & Cost Management** ← **Upgrade and Manage Payment** ← **Upgrade to Pay As You Go**.
2. ثم **Budgets** ← **Create budget**: المبلغ `1` دولار، وأضف تنبيهًا بالبريد عند 50%. هكذا تعرف فورًا لو ظهرت أي تكلفة.
3. التزم بما عليه علامة **Always Free** فقط عند إنشاء أي مورد.

## 3) إنشاء الجهاز الافتراضي
1. ☰ ← **Compute** ← **Instances** ← **Create instance**.
2. **Name:** `mthse`.
3. **Image and shape ← Edit:**
   - Image: **Canonical Ubuntu 24.04** (إصدار aarch64 / ARM).
   - Shape: **Ampere** ← `VM.Standard.A1.Flex` ← **2 OCPU** و**12 GB** ذاكرة (يجب أن تظهر عليه علامة Always Free eligible).
4. **Networking:** اترك الخيارات الافتراضية (إنشاء شبكة جديدة + Public subnet) وتأكد أن **Assign a public IPv4 address** مفعّل.
5. **Add SSH keys:** اختر **Generate a key pair for me** ← حمّل **Save private key** (احفظه في مكان آمن، لا تفقده ولا ترسله لأحد) وحمّل المفتاح العام أيضًا.
6. **Boot volume:** اجعل الحجم 100 GB (ضمن حد المجاني).
7. اضغط **Create**. انتظر الحالة **Running**، ثم انسخ **Public IP address**.

## 4) فتح المنفذين 80 و443
**(أ) في شبكة Oracle:** صفحة الجهاز ← **Primary VNIC** ← اضغط اسم **Subnet** ← **Security Lists** ← **Default Security List** ← **Add Ingress Rules** وأضف قاعدتين:
- Source CIDR: `0.0.0.0/0` — IP Protocol: TCP — Destination Port Range: `80`
- Source CIDR: `0.0.0.0/0` — IP Protocol: TCP — Destination Port Range: `443`

**(ب) داخل الجهاز:** يتولاه سكربت التجهيز في القسم 6.

## 5) الاتصال بالجهاز من ويندوز
1. ضع ملف المفتاح الخاص في `C:\Users\<اسمك>\.ssh\oracle.key`.
2. افتح **PowerShell** ونفّذ:
```powershell
ssh -i C:\Users\<اسمك>\.ssh\oracle.key ubuntu@<الـ IP العام>
```
اكتب `yes` أول مرة. إذا ظهر خطأ `UNPROTECTED PRIVATE KEY FILE` فنفّذ:
```powershell
icacls C:\Users\<اسمك>\.ssh\oracle.key /inheritance:r
icacls C:\Users\<اسمك>\.ssh\oracle.key /grant:r "$($env:USERNAME):(R)"
```
3. إذا ظهر `ubuntu@mthse:~$` فأنت داخل الجهاز. (المستخدم دائمًا `ubuntu`.)

## 6) نطاق مجاني + Firebase
1. ادخل `https://www.duckdns.org` بحساب Google أو GitHub، واكتب اسمًا في **sub domain** (مثل `mthse-reliance`) ← **add domain**، ثم ضع **الـ IP العام** في خانة current ip ← **update ip**.
2. تحقق من PowerShell: `nslookup mthse-reliance.duckdns.org` يجب أن يُظهر الـ IP نفسه.
3. في Firebase: **Authentication ← Settings ← Authorized domains ← Add domain** ← أضف `mthse-reliance.duckdns.org` (بدون https).

## 7) تجهيز السيرفر وجلب الكود
داخل الجهاز (ssh):
```bash
# مفتاح قراءة فقط للمستودع الخاص (Deploy key)
ssh-keygen -t ed25519 -C mthse-server -f ~/.ssh/github_deploy -N ""
cat ~/.ssh/github_deploy.pub
```
انسخ السطر الظاهر. في GitHub: المستودع ← **Settings** ← **Deploy keys** ← **Add deploy key** ← الصقه (اترك **Allow write access** غير مفعّل) ← **Add key**. ثم:
```bash
cat >> ~/.ssh/config <<'CFG'
Host github.com
  IdentityFile ~/.ssh/github_deploy
  IdentitiesOnly yes
CFG
chmod 600 ~/.ssh/config
git clone git@github.com:mt-hse-platform/mt-hse-platform.git
cd mt-hse-platform
bash ops/setup-server.sh
```
(اكتب `yes` عند سؤال بصمة github.com.) بعد انتهاء السكربت اخرج وادخل مجددًا (`exit` ثم ssh من جديد) ثم تأكد:
```bash
docker run --rm hello-world
```

## 8) الإعدادات السرية
```bash
cd ~/mt-hse-platform
cp .env.production.example .env.production
nano .env.production
```
غيّر: `DOMAIN` إلى نطاقك، وضع كلمتي مرور قويتين (ولّدهما بهذا الأمر ونفّذه مرتين):
```bash
openssl rand -base64 24 | tr -d '/+='
```
(في nano: احفظ بـ `Ctrl+O` ثم Enter، واخرج بـ `Ctrl+X`.) ثم `chmod 600 .env.production`. **لا ترسل هذا الملف لأحد.**

## 9) أول تشغيل
```bash
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
```
يستغرق 10–20 دقيقة في المرة الأولى. للمتابعة:
```bash
docker compose --env-file .env.production -f docker-compose.prod.yml ps
docker compose --env-file .env.production -f docker-compose.prod.yml logs api --tail 50
```
المتوقع: `postgres` و`api` و`caddy` تعمل، و`migrate` منتهية بـ Exited (0). ثم:
```bash
curl -s https://<نطاقك>/api/health
```
يجب أن يظهر `{"ok":true}` (شهادة HTTPS تُنشأ تلقائيًا خلال دقيقة).

## 10) إنشاء المؤسسة والمدير الأول
في Firebase ← Authentication ← Users: انسخ **User UID** للمدير. ثم:
```bash
./ops/bootstrap-org.sh "ريلاينس ريدى ميكس" mt.hse.platform@gmail.com "محمد طاهر" <User UID>
```
(إن ظهرت الحروف العربية علامات استفهام في الطرفية فاستعمل اسمًا إنجليزيًا الآن.)

## 11) التجربة الأولى
1. افتح `https://<نطاقك>` وسجّل الدخول بحساب المدير.
2. **المستخدمون** ← أضف موقعًا، ثم ادعُ موظفًا.
3. **النماذج** ← استيراد من JSON ← الصق محتوى `docs/sample-template-batching-plant.json` ← فحص ← نشر.
4. **التفتيش** ← بدء تفتيش ← أجب ← إكمال ← عرض التقرير ← تنزيل PDF (**افحص أن العربية سليمة**).

## 12) النسخ الاحتياطي (إلزامي)
```bash
./ops/backup.sh          # جرّبه مرة
ls -la backups/
crontab -e               # اختر nano ثم أضف السطر التالي في آخر الملف:
```
```
0 2 * * * cd /home/ubuntu/mt-hse-platform && ./ops/backup.sh >> backups/backup.log 2>&1
```
**النسخ على نفس السيرفر لا يحميك من ضياع السيرفر.** أسبوعيًا من جهازك (PowerShell):
```powershell
scp -i C:\Users\<اسمك>\.ssh\oracle.key "ubuntu@<IP>:/home/ubuntu/mt-hse-platform/backups/*.sql.gz" D:\mthse-backups\
```
جرّب الاستعادة مرة على قاعدة منفصلة (آمنة، لا تمس القاعدة الحية):
```bash
./ops/restore.sh backups/<اسم ملف>.sql.gz
```

## 13) التحديث لاحقًا
ارفع التعديلات على GitHub، ثم على السيرفر:
```bash
cd ~/mt-hse-platform && ./ops/deploy.sh
```

## 14) المراقبة
سجّل في `uptimerobot.com` (مجاني) ← **Add monitor** ← HTTP(s) ← `https://<نطاقك>/api/health` كل 5 دقائق ← تنبيه بالبريد.

## 15) مشكلات شائعة
| المشكلة | الحل |
|---|---|
| Out of host capacity عند إنشاء الجهاز | أعد المحاولة في وقت آخر، أو جرّب 1 OCPU، أو استعمل سيرفر مدفوع صغير |
| `Permission denied (publickey)` | المستخدم يجب أن يكون `ubuntu`، ومسار المفتاح صحيح |
| `Connection timed out` | القاعدتان في القسم 4(أ) غير مضافتين، أو لم يُنفَّذ `setup-server.sh` |
| الشهادة لا تصدر / الموقع لا يفتح | النطاق لا يشير للـ IP (nslookup)، أو المنفذان 80/443 مغلقان |
| "unauthorized-domain" عند الدخول | أضف النطاق في Firebase ← Authorized domains |
| `api` لا يصير healthy | `docker compose ... logs api --tail 100` وأرسل لي النص |
| PDF حروفه العربية مربعات | الخطوط لم تُثبَّت في الصورة؛ أرسل لي لقطة |
| صفحة بيضاء بعد الدخول | افتح أدوات المطور (F12) ← Console وأرسل الأخطاء |
| `permission denied` على docker | اخرج وادخل مجددًا بعد `setup-server.sh` |
