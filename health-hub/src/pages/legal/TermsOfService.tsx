const TermsOfService = () => (
  <div className="min-h-screen bg-white py-16 px-6">
    <div className="max-w-3xl mx-auto space-y-8">
      <h1 className="text-3xl font-bold text-foreground">Terms of Service</h1>
      <p className="text-sm text-muted-foreground">Last updated: March 1, 2026</p>

      <section className="space-y-3 text-foreground text-sm leading-relaxed">
        <h2 className="text-lg font-semibold text-foreground">1. Acceptance of Terms</h2>
        <p>
          By accessing and using the Sobhana Diagnostic Centre portal, you agree to be bound by these
          Terms of Service. If you do not agree, please do not use our services.
        </p>
      </section>

      <section className="space-y-3 text-foreground text-sm leading-relaxed">
        <h2 className="text-lg font-semibold text-foreground">2. Services</h2>
        <p>
          Sobhana Diagnostic Centre &amp; Multi Speciality Clinic provides diagnostic laboratory
          services, medical report generation, and related healthcare services. This portal enables
          staff to manage patient records, process diagnostic orders, and deliver results.
        </p>
      </section>

      <section className="space-y-3 text-foreground text-sm leading-relaxed">
        <h2 className="text-lg font-semibold text-foreground">3. User Accounts</h2>
        <ul className="list-disc pl-5 space-y-1">
          <li>Access is granted only to authorized clinic staff, doctors, and administrators</li>
          <li>You are responsible for maintaining the confidentiality of your login credentials</li>
          <li>You must not share your account with unauthorized individuals</li>
          <li>Report any unauthorized access immediately to clinic management</li>
        </ul>
      </section>

      <section className="space-y-3 text-foreground text-sm leading-relaxed">
        <h2 className="text-lg font-semibold text-foreground">4. Patient Data</h2>
        <p>
          All patient data must be handled in accordance with applicable Indian healthcare regulations
          and data protection laws. Unauthorized disclosure of patient information is strictly prohibited.
        </p>
      </section>

      <section className="space-y-3 text-foreground text-sm leading-relaxed">
        <h2 className="text-lg font-semibold text-foreground">5. WhatsApp Notifications</h2>
        <p>
          Our portal may send WhatsApp messages to patients for informational purposes only, such as
          report availability and billing confirmations. These messages are sent only with patient
          consent and comply with Meta's WhatsApp Business policies.
        </p>
      </section>

      <section className="space-y-3 text-foreground text-sm leading-relaxed">
        <h2 className="text-lg font-semibold text-foreground">6. Limitation of Liability</h2>
        <p>
          This portal is a management tool and does not replace professional medical judgment.
          Sobhana Diagnostic Centre is not liable for decisions made based solely on portal data.
        </p>
      </section>

      <section className="space-y-3 text-foreground text-sm leading-relaxed">
        <h2 className="text-lg font-semibold text-foreground">7. Contact</h2>
        <p>
          For questions about these terms, contact us at:{' '}
          <a href="mailto:sobhanadiagnostics@gmail.com" className="text-blue-600 underline">
            sobhanadiagnostics@gmail.com
          </a>
        </p>
      </section>
    </div>
  </div>
);

export default TermsOfService;
