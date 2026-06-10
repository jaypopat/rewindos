import { Input } from "@/components/ui/input";

export function TextInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="font-mono"
    />
  );
}
