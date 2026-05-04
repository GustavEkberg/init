export default async function Layout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <div className="min-h-dvh flex items-center justify-center md:max-w-lg md:mx-auto">
      <div className="flex flex-col justify-center items-center gap-8 w-full mx-8">
        <h1 className="text-3xl font-semibold tracking-tight">Init</h1>
        {children}
      </div>
    </div>
  );
}
