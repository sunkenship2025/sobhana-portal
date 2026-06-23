const PrivacyPolicy = () => (
  <div className="min-h-screen bg-white py-16 px-6">
    <div className="max-w-3xl mx-auto space-y-8">
      <h1 className="text-3xl font-bold text-foreground">Privacy Policy</h1>
      <p className="text-sm text-muted-foreground">Last updated: March 1, 2026</p>

      <section className="space-y-3 text-foreground text-sm leading-relaxed">
        <h2 className="text-lg font-semibold text-foreground">1. Introduction</h2>
        <p>
          Sobhana Diagnostic Centre &amp; Multi Speciality Clinic ("we", "our", "us") is committed to
          protecting your personal information and your right to privacy. This Privacy Policy explains
          how we collect, use, and safeguard your information when you use our portal and services.
        </p>
      </section>

      <section className="space-y-3 text-foreground text-sm leading-relaxed">
        <h2 className="text-lg font-semibold text-foreground">2. Information We Collect</h2>
        <ul className="list-disc pl-5 space-y-1">
          <li>Patient name, date of birth, gender, and contact details</li>
          <li>Phone numbers for WhatsApp notifications (with explicit consent)</li>
          <li>Diagnostic test results and medical reports</li>
          <li>Billing and payment information</li>
          <li>Staff login credentials (email and role)</li>
        </ul>
      </section>

      <section className="space-y-3 text-foreground text-sm leading-relaxed">
        <h2 className="text-lg font-semibold text-foreground">3. How We Use Your Information</h2>
        <ul className="list-disc pl-5 space-y-1">
          <li>To provide diagnostic services and generate medical reports</li>
          <li>To send WhatsApp notifications about report availability and billing</li>
          <li>To manage patient records and visit history</li>
          <li>To process payments and generate bills</li>
        </ul>
      </section>

      <section className="space-y-3 text-foreground text-sm leading-relaxed">
        <h2 className="text-lg font-semibold text-foreground">4. WhatsApp Messaging</h2>
        <p>
          We use Meta's WhatsApp Business API to send informational notifications only. Messages are
          sent only to patients who have explicitly opted in. You can opt out at any time by informing
          our clinic staff. We do not send marketing or promotional messages.
        </p>
      </section>

      <section className="space-y-3 text-foreground text-sm leading-relaxed">
        <h2 className="text-lg font-semibold text-foreground">5. Data Security</h2>
        <p>
          We implement industry-standard security measures including encrypted data transmission (SSL/TLS),
          secure database storage, role-based access controls, and audit logging of all data access.
        </p>
      </section>

      <section className="space-y-3 text-foreground text-sm leading-relaxed">
        <h2 className="text-lg font-semibold text-foreground">6. Data Retention</h2>
        <p>
          Medical records are retained as required by applicable Indian healthcare regulations.
          Message logs are retained for delivery tracking purposes and may be deleted upon request.
        </p>
      </section>

      <section className="space-y-3 text-foreground text-sm leading-relaxed">
        <h2 className="text-lg font-semibold text-foreground">7. Contact</h2>
        <p>
          For privacy-related inquiries, contact us at:{' '}
          <a href="mailto:sobhanadiagnostics@gmail.com" className="text-blue-600 underline">
            sobhanadiagnostics@gmail.com
          </a>
        </p>
      </section>
    </div>
  </div>
);

export default PrivacyPolicy;
