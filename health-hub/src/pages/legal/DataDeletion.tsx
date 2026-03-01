const DataDeletion = () => (
  <div className="min-h-screen bg-white py-16 px-6">
    <div className="max-w-3xl mx-auto space-y-8">
      <h1 className="text-3xl font-bold text-gray-900">Data Deletion Instructions</h1>
      <p className="text-sm text-gray-500">Last updated: March 1, 2026</p>

      <section className="space-y-3 text-gray-700 text-sm leading-relaxed">
        <h2 className="text-lg font-semibold text-gray-900">How to Request Data Deletion</h2>
        <p>
          If you wish to have your data deleted from our systems, you can submit a request through
          any of the following methods:
        </p>
      </section>

      <section className="space-y-3 text-gray-700 text-sm leading-relaxed">
        <h2 className="text-lg font-semibold text-gray-900">1. Email Request</h2>
        <p>
          Send an email to{' '}
          <a href="mailto:sobhanadiagnostics@gmail.com" className="text-blue-600 underline">
            sobhanadiagnostics@gmail.com
          </a>{' '}
          with the subject line "Data Deletion Request" and include:
        </p>
        <ul className="list-disc pl-5 space-y-1">
          <li>Your full name</li>
          <li>Phone number registered with us</li>
          <li>Description of what data you want deleted</li>
        </ul>
      </section>

      <section className="space-y-3 text-gray-700 text-sm leading-relaxed">
        <h2 className="text-lg font-semibold text-gray-900">2. In-Person Request</h2>
        <p>
          Visit Sobhana Diagnostic Centre and speak to our front desk staff to submit a data
          deletion request in person.
        </p>
      </section>

      <section className="space-y-3 text-gray-700 text-sm leading-relaxed">
        <h2 className="text-lg font-semibold text-gray-900">What We Delete</h2>
        <ul className="list-disc pl-5 space-y-1">
          <li>WhatsApp message logs and notification history</li>
          <li>Contact information and communication preferences</li>
          <li>Portal account data (for staff accounts)</li>
        </ul>
      </section>

      <section className="space-y-3 text-gray-700 text-sm leading-relaxed">
        <h2 className="text-lg font-semibold text-gray-900">What We May Retain</h2>
        <p>
          Certain medical records may be retained as required by Indian healthcare regulations and
          legal obligations. We will inform you of any data that cannot be deleted and the reason
          for retention.
        </p>
      </section>

      <section className="space-y-3 text-gray-700 text-sm leading-relaxed">
        <h2 className="text-lg font-semibold text-gray-900">Processing Time</h2>
        <p>
          Data deletion requests are processed within 30 days. You will receive a confirmation
          once your data has been deleted.
        </p>
      </section>
    </div>
  </div>
);

export default DataDeletion;
