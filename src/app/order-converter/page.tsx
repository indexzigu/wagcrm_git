import OrderDashboard from '@/components/crm/order-dashboard';

export default function OrderConverterPage() {
  return (
    <div className="flex-1 w-full bg-slate-50 font-sans text-slate-900">
      <div className="w-full h-full max-w-full">
        <OrderDashboard />
      </div>
    </div>
  );
}
