import { ChannelFeesClient } from "@/components/crm/channel-fees-client";
import { getCachedChannelFeeConfig } from "@/lib/cached-crm-data";

export default async function ChannelFeesPage() {
  const channels = await getCachedChannelFeeConfig();

  return <ChannelFeesClient initialChannels={channels} />;
}
