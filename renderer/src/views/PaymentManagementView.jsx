import React from "react";
import Card from "../components/Card";

export default function PaymentManagementView({ currentViewMeta }) {
  return (
    <section>
      <Card>
        <div className="py-12 text-center space-y-2">
          <p className="text-xl font-semibold text-slate-700">{currentViewMeta?.label || "Payment Management"}</p>
          <p className="text-slate-500">
            This view is under construction. Check back soon for tailored insights and workflows.
          </p>
        </div>
      </Card>
    </section>
  );
}
